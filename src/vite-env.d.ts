/// <reference types="vite/client" />
/// <reference types="@webgpu/types" />

// WebGPU Navigator extension (for browsers that support it)
interface Navigator {
  gpu?: GPU;
}
