import { GPUShaderModuleCacheKey } from "../scene/cache";
import { BuildOptions, Buildable, Updatable } from "../scene/types";
import { GPUResource } from "../type";
import { Observable } from "../utils/Observable";

export abstract class Material implements Buildable, Updatable, Observable {
  abstract watch: PropertyKey[];
  abstract update(device: GPUDevice): void;
  abstract build(
    options: BuildOptions,
    bindGroupLayoutEntry?: GPUBindGroupLayoutEntry
  ): {
    bindGroupIndex: number;
    bindGroupLayout: GPUBindGroupLayout;
    bindGroupLayouts: GPUBindGroupLayout[];
    resources: GPUResource[];
    fragment: GPUShaderModuleCacheKey;
  };
}