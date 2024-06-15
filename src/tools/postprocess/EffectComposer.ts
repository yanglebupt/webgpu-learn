import { WebGPURenderer } from "../renderer";
import { Scene } from "../scene";
import { Renderable } from "../scene/types";
import { ComputePass } from "./ComputePass";
import { Pass } from "./Pass";
import { RenderPass } from "./RenderPass";

export class EffectComposer implements Renderable<() => void> {
  passes: Pass[] = [];
  renderer: WebGPURenderer;
  device: GPUDevice;
  canvasAppended: boolean = false;
  descriptor: GPUTextureDescriptor;

  constructor(public scene: Scene) {
    this.renderer = scene.renderer;
    this.device = this.renderer.device;
    const { width, height, format, usage } =
      this.renderer.ctx.getCurrentTexture();
    this.descriptor = {
      size: [width, height],
      format,
      usage,
    };
  }

  addPass(pass: Pass) {
    pass.build(this.scene.buildOptions, this.descriptor);
    this.passes.push(pass);
  }

  render() {
    /* 最终的结果仍然是渲染到原始 canvas 中，不会去新建一个 canvas */
    if (!this.canvasAppended) {
      this.renderer.appendCanvas();
      this.canvasAppended = true;
    }

    if (this.passes.length === 0) return this.scene.render();

    const encoder = this.device.createCommandEncoder();
    this.renderer.renderScene(this.scene, encoder);
    this.passes.forEach((pass, idx) => {
      const txt =
        idx > 0
          ? this.passes[idx - 1].texture
          : this.renderer.ctx.getCurrentTexture();
      const isEnd = idx === this.passes.length - 1;
      const target = isEnd ? this.renderer.ctx.getCurrentTexture() : undefined;
      pass.render(encoder, this.device, txt, { isEnd, target });
    });
    this.device.queue.submit([encoder.finish()]);
  }
}
