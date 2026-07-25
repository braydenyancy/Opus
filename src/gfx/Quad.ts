import { BufferAttribute, BufferGeometry, Camera, Mesh, Scene, type ShaderMaterial, type WebGLRenderTarget, type WebGLRenderer } from 'three';

/** A single full-screen triangle. Cheaper and seam-free compared to a quad. */
export class Quad {
  private static geometry: BufferGeometry | null = null;
  private readonly scene = new Scene();
  private readonly camera = new Camera();
  private readonly mesh: Mesh;

  constructor(material: ShaderMaterial) {
    if (!Quad.geometry) {
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
      g.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
      Quad.geometry = g;
    }
    this.mesh = new Mesh(Quad.geometry, material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  get material(): ShaderMaterial {
    return this.mesh.material as ShaderMaterial;
  }

  render(renderer: WebGLRenderer, target: WebGLRenderTarget | null, clear = true): void {
    renderer.setRenderTarget(target);
    if (clear) renderer.clear(true, false, false);
    renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.material.dispose();
  }
}
