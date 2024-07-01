import { getBindGroupEntries } from "..";
import { EntityObject } from "../entitys/EntityObject";
import { Geometry } from "../geometrys/Geometry";
import { ShaderBuildResult } from "../materials/Material";
import { MeshMaterial } from "../materials/MeshMaterial";
import { GPUShaderModuleCacheKey } from "../scene/cache";
import { BuildOptions } from "../scene/types";
import { ShaderLocation } from "../shaders";
import vertex from "../shaders/vertex-wgsl/normal.wgsl";
import wireframe from "../shaders/vertex-wgsl/wireframe.wgsl";
import { GPUResource } from "../type";
import { getBlendFromPreset } from "../utils/Blend";
import {
  ObservableActionParams,
  ObservableProxy,
  WatchPropertyKey,
} from "../utils/Observable";

export enum WatchAction {
  Geometry = "buildGeometry",
  Material = "buildMaterial",
  Pipeline = "buildPipeline",
  Component = "buildComponent",
}

/**
 * 与 Unity 不同的是，这里我们将 Mesh 认为是 EntityObject，而不是 Component
 */
export class Mesh<
  G extends Geometry = Geometry,
  M extends MeshMaterial = MeshMaterial
> extends EntityObject {
  static watch: WatchPropertyKey = {
    wireframe: [WatchAction.Geometry, WatchAction.Pipeline],
    blending: [WatchAction.Pipeline],
    blendingPreset: [WatchAction.Pipeline],
  };
  public geometry: G;
  private _material: M;
  public type = "Mesh";

  private buildOptions!: BuildOptions;
  private renderPipeline!: GPURenderPipeline;

  private materialBuildResult!: {
    vertex?: ShaderBuildResult;
    fragment: ShaderBuildResult;
    vertexBindingStart: number;
  };

  private geometryBuildResult!: {
    vertexCount: number;
    vertexBuffer?: GPUBuffer;
    bufferLayout?: GPUVertexBufferLayout[];
    vertex: GPUShaderModuleCacheKey<any>;
    bindGroupLayoutEntries: GPUBindGroupLayoutEntry[];
    resources: GPUResource[];
    indices: {
      buffer: GPUBuffer;
      format: GPUIndexFormat;
      indexCount: number;
    } | null;
  };

  private componentBuildResult!: {
    transformUniformValue: Float32Array;
    vertexResources: GPUResource[];
  };

  private vertexResources!: {
    bindGroups: GPUBindGroup[];
    bindGroupLayouts: GPUBindGroupLayout[];
    code: GPUShaderModuleCacheKey<any>;
  };

  private fragmentResources!: {
    bindGroups: GPUBindGroup[];
    bindGroupLayouts: GPUBindGroupLayout[];
    code: GPUShaderModuleCacheKey<any>;
  };

  constructor(geometry: G, material: M) {
    super();
    this.geometry = geometry;
    this._material = this.observeMaterial(material);
  }

  private observeMaterial(material: M) {
    return new ObservableProxy(
      material,
      [
        {
          action: this.onChange.bind(this),
          watch: Mesh.watch,
        },
      ],
      { exclude: Object.keys(Mesh.watch) }
    ) as M;
  }

  get material() {
    return this._material as M;
  }

  set material(material: M) {
    this._material = this.observeMaterial(material);
  }

  onChange({ payload }: ObservableActionParams) {
    (payload as WatchAction[]).forEach((p) => {
      Reflect.apply(this[p], this, this.getArgumentsList(p));
      // 副作用
      if (p === WatchAction.Component || p === WatchAction.Geometry)
        this.buildVertexResources(this.buildOptions);
      else if (p === WatchAction.Material)
        this.buildFragmentResources(this.buildOptions);
    });
  }

  getArgumentsList(p: WatchAction) {
    return p === WatchAction.Pipeline || p === WatchAction.Material
      ? [this.buildOptions]
      : [this.buildOptions.device];
  }

  render(renderPass: GPURenderPassEncoder, device: GPUDevice) {
    super.render(renderPass, device);
    const { vertexBuffer, vertexCount, indices } = this.geometryBuildResult;
    renderPass.setPipeline(this.renderPipeline);
    if (vertexBuffer) renderPass.setVertexBuffer(0, vertexBuffer);
    this.bindGroups.forEach((group, index) => {
      renderPass.setBindGroup(index + 1, group);
    });
    if (indices) {
      renderPass.setIndexBuffer(indices.buffer, indices.format);
      renderPass.drawIndexed(indices.indexCount);
    } else {
      renderPass.draw(vertexCount);
    }
  }

  updateBuffers(device: GPUDevice) {
    const { transformUniformValue, vertexResources } =
      this.componentBuildResult;
    const transformUniform = vertexResources[0] as GPUBuffer;
    transformUniformValue.set(this.transform.worldMatrix, 0);
    transformUniformValue.set(this.transform.worldNormalMatrix, 16);
    device.queue.writeBuffer(transformUniform, 0, transformUniformValue);
  }

  buildWireframe(device: GPUDevice) {
    const geometry = this.geometry;
    const { positions, indices, normals, uvs } = geometry.attributes;
    const vertexCount = !!indices
      ? indices.length
      : geometry.getCount("POSITION");

    const { vertexBindingStart: bindingStart } = this.materialBuildResult;
    const bindGroupLayoutEntries: GPUBindGroupLayoutEntry[] = [
      {
        binding: bindingStart,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "read-only-storage" },
      },
    ];
    const resources: GPUResource[] = [];

    [positions, indices, normals, uvs].forEach((array, idx) => {
      if (array === undefined) return;
      const isIndex = idx === 1;
      const buffer = device.createBuffer({
        size: isIndex
          ? array.length * Uint32Array.BYTES_PER_ELEMENT
          : array.byteLength,
        usage: GPUBufferUsage.STORAGE,
        mappedAtCreation: true,
      });
      resources.push(buffer);
      new (isIndex ? Uint32Array : Float32Array)(buffer.getMappedRange()).set(
        array
      );
      buffer.unmap();

      bindGroupLayoutEntries.push({
        binding: bindingStart + idx + 1,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "read-only-storage" },
      });
    });

    this.geometryBuildResult = {
      vertexCount: vertexCount * 2,
      vertex: {
        code: wireframe,
        context: { useNormal: !!normals, useTexcoord: !!uvs, bindingStart },
      },
      resources,
      indices: null,
      bindGroupLayoutEntries: bindGroupLayoutEntries,
    };
  }

  buildGeometry(device: GPUDevice) {
    if (this.material.wireframe) return this.buildWireframe(device);
    const geometry = this.geometry;
    const indexFormat = geometry.indexFormat;
    const { positions, indices, uvs, normals } = geometry.attributes;
    const vertexCount = geometry.getCount("POSITION");
    const useNormal = !!normals;
    const useTexcoord = !!uvs;
    const arrayStride =
      Float32Array.BYTES_PER_ELEMENT *
      (3 + (useNormal ? 3 : 0) + (useTexcoord ? 2 : 0));

    const attributes: GPUVertexAttribute[] = [
      {
        shaderLocation: ShaderLocation.POSITION,
        format: "float32x3",
        offset: 0,
      },
    ];
    if (useNormal)
      attributes.push({
        shaderLocation: ShaderLocation.NORMAL,
        format: "float32x3",
        offset: 3 * Float32Array.BYTES_PER_ELEMENT,
      });
    if (useTexcoord)
      attributes.push({
        shaderLocation: ShaderLocation.TEXCOORD_0,
        format: "float32x2",
        offset: (3 + (useNormal ? 3 : 0)) * Float32Array.BYTES_PER_ELEMENT,
      });
    const bufferLayout: GPUVertexBufferLayout[] = [
      {
        arrayStride,
        stepMode: "vertex",
        attributes,
      },
    ];

    const vertexBuffer = device.createBuffer({
      size: arrayStride * vertexCount,
      usage: GPUBufferUsage.VERTEX,
      mappedAtCreation: true,
    });
    const vertexData = new Float32Array(vertexBuffer.getMappedRange());

    for (let i = 0; i < vertexCount; i++) {
      const vertex = positions.slice(i * 3, (i + 1) * 3);
      const normal = useNormal ? normals.slice(i * 3, (i + 1) * 3) : [];
      const uv = useTexcoord ? uvs.slice(i * 2, (i + 1) * 2) : [];
      vertexData.set(
        Float32Array.of(...vertex, ...normal, ...uv),
        (i * arrayStride) / Float32Array.BYTES_PER_ELEMENT
      );
    }
    vertexBuffer.unmap();

    let indexBuffer: GPUBuffer | null = null;
    if (indices) {
      indexBuffer = device.createBuffer({
        usage: GPUBufferUsage.INDEX,
        size: indices.length * indices.BYTES_PER_ELEMENT,
        mappedAtCreation: true,
      });
      new (indexFormat === "uint16" ? Uint16Array : Uint32Array)(
        indexBuffer.getMappedRange()
      ).set(indices);
      indexBuffer.unmap();
    }

    const { vertexBindingStart: bindingStart } = this.materialBuildResult;
    this.geometryBuildResult = {
      vertexCount,
      vertexBuffer,
      bufferLayout,
      vertex: {
        code: vertex,
        context: { useNormal, useTexcoord, bindingStart },
      },
      indices: indices
        ? {
            buffer: indexBuffer!,
            format: indexFormat!,
            indexCount: indices.length,
          }
        : null,
      bindGroupLayoutEntries: [
        {
          binding: bindingStart,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: "read-only-storage" },
        },
      ],
      resources: [],
    };
  }

  buildComponent(device: GPUDevice) {
    const transformUniform = device.createBuffer({
      size: Float32Array.BYTES_PER_ELEMENT * 4 * 4 * 2,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
    });
    const transformUniformValue = new Float32Array(
      transformUniform.size / Float32Array.BYTES_PER_ELEMENT
    );

    this.componentBuildResult = {
      transformUniformValue,
      vertexResources: [transformUniform],
    };

    this.updateBuffers(device);
  }

  buildMaterial(options: BuildOptions) {
    const res = this.material.build(options);
    const vertexBindingStart = res.vertex?.bindGroupLayoutEntries.length ?? 0;
    this.materialBuildResult = { vertexBindingStart, ...res };
  }

  /**
   * vertex 和 fragment 拆分成两个 bindGroup
   * ShaderMaterial 可能会修改 vertex，这里需要判断使用默认的 vertex 还是 material 提供的 vertex
   */
  buildVertexResources(options: BuildOptions) {
    const { device, cached, scene } = options;

    const { bindGroupLayoutEntries, resources } = this.geometryBuildResult;
    const { vertexResources } = this.componentBuildResult;
    const { vertex } = this.materialBuildResult;

    const bindGroupLayout = cached.bindGroupLayout.get(
      (vertex?.bindGroupLayoutEntries ?? []).concat(bindGroupLayoutEntries)
    );
    const bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: getBindGroupEntries(
        vertex?.resources ?? [],
        vertexResources,
        resources
      ),
    });

    this.vertexResources = {
      bindGroupLayouts: [scene.bindGroupLayout, bindGroupLayout],
      bindGroups: [bindGroup],
      code: !!vertex ? vertex.shader : this.geometryBuildResult.vertex,
    };
  }

  buildFragmentResources(options: BuildOptions) {
    const { cached } = options;
    const { fragment } = this.materialBuildResult;

    const bindGroupLayout = cached.bindGroupLayout.get(
      fragment.bindGroupLayoutEntries
    );
    const bindGroup = options.device.createBindGroup({
      layout: bindGroupLayout,
      entries: getBindGroupEntries(fragment.resources),
    });

    this.fragmentResources = {
      code: fragment.shader,
      bindGroups: [bindGroup],
      bindGroupLayouts: [bindGroupLayout],
    };
  }

  get bindGroups() {
    return this.vertexResources.bindGroups.concat(
      this.fragmentResources.bindGroups
    );
  }

  get resources() {
    return {
      bindGroupLayouts: this.vertexResources.bindGroupLayouts.concat(
        this.fragmentResources.bindGroupLayouts
      ),
      vertex: this.vertexResources.code,
      fragment: this.fragmentResources.code,
    };
  }

  buildPipeline(options: BuildOptions) {
    const { bufferLayout } = this.geometryBuildResult;
    const { bindGroupLayouts, fragment, vertex } = this.resources;
    const blending = this.material.blendingPreset
      ? getBlendFromPreset(this.material.blendingPreset)
      : this.material.blending;
    this.renderPipeline = options.cached.pipeline.get(
      vertex,
      fragment,
      {
        format: options.format,
        /**
         * 三角面和线框有不同，例如一个平面，两个三角面 6个点，只能画出 3 条线，缺两条线
         * 因此我们需要重新计算 line-list 的 buffer，同时线框不需要 material，因此可以考虑单独用一个 Wireframe 的类来实现
         * 生成 line-list 需要注意，不要添加了重复的线
         */
        primitive: {
          topology: this.material.wireframe ? "line-list" : "triangle-list",
        },
        depthStencil: {
          format: options.depthFormat,
          depthWriteEnabled: true,
          depthCompare: "less",
        },
        // 没有则不添加该属性，undefined 的属性会被 JSON.stringify() 清除，但 null 不会
        multisample: options.antialias ? { count: 4 } : undefined,
        bufferLayout,
        blending,
      },
      bindGroupLayouts
    );
  }

  build(options: BuildOptions) {
    this.buildOptions = options;
    const device = options.device;
    /////////////////// 解析 Material /////////////////////////
    this.buildMaterial(options);
    ///////////// 解析 Geometry ////////////////
    this.buildGeometry(device);
    ///////// 解析自己的组件(组件内部也可以有自己的组件) ///////////
    this.buildComponent(device);
    /////////////////// 创建 vertex 和 fragment 资源 /////////////////////////
    this.buildVertexResources(options);
    this.buildFragmentResources(options);
    /////////////////// 创建 pipeline //////////////////
    this.buildPipeline(options);

    super.build(options);
  }
}
