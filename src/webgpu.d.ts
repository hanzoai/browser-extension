// Ambient WebGPU type declarations for browser extension
// Full types available via @webgpu/types package if needed

interface GPU {
  requestAdapter(options?: GPURequestAdapterOptions): Promise<GPUAdapter | null>;
}

interface GPURequestAdapterOptions {
  powerPreference?: 'low-power' | 'high-performance';
}

interface GPUAdapter {
  features: ReadonlySet<string>;
  requestDevice(descriptor?: GPUDeviceDescriptor): Promise<GPUDevice>;
}

interface GPUDeviceDescriptor {
  requiredFeatures?: string[];
  requiredLimits?: Record<string, number>;
}

interface GPUDevice {
  queue: GPUQueue;
  createBuffer(descriptor: GPUBufferDescriptor): GPUBuffer;
  createShaderModule(descriptor: GPUShaderModuleDescriptor): GPUShaderModule;
  createComputePipeline(descriptor: GPUComputePipelineDescriptor): GPUComputePipeline;
  createBindGroup(descriptor: GPUBindGroupDescriptor): GPUBindGroup;
  createBindGroupLayout(descriptor: GPUBindGroupLayoutDescriptor): GPUBindGroupLayout;
  createCommandEncoder(): GPUCommandEncoder;
}

interface GPUQueue {
  submit(commandBuffers: GPUCommandBuffer[]): void;
  writeBuffer(buffer: GPUBuffer, offset: number, data: BufferSource): void;
}

interface GPUBuffer {
  size: number;
  mapAsync(mode: number): Promise<void>;
  getMappedRange(): ArrayBuffer;
  unmap(): void;
}

interface GPUShaderModule {}

interface GPUComputePipeline {}

interface GPUBindGroup {}

interface GPUBindGroupLayout {}

interface GPUCommandEncoder {
  beginComputePass(): GPUComputePassEncoder;
  copyBufferToBuffer(src: GPUBuffer, srcOff: number, dst: GPUBuffer, dstOff: number, size: number): void;
  finish(): GPUCommandBuffer;
}

interface GPUComputePassEncoder {
  setPipeline(pipeline: GPUComputePipeline): void;
  setBindGroup(index: number, bindGroup: GPUBindGroup): void;
  dispatchWorkgroups(x: number, y?: number, z?: number): void;
  end(): void;
}

interface GPUCommandBuffer {}

interface GPUBufferDescriptor {
  size: number;
  usage: number;
}

interface GPUShaderModuleDescriptor {
  code: string;
}

interface GPUComputePipelineDescriptor {
  layout: 'auto' | GPUPipelineLayout;
  compute: { module: GPUShaderModule; entryPoint: string };
}

interface GPUPipelineLayout {}

interface GPUBindGroupDescriptor {
  layout: GPUBindGroupLayout;
  entries: GPUBindGroupEntry[];
}

interface GPUBindGroupEntry {
  binding: number;
  resource: { buffer: GPUBuffer } | GPUExternalTexture;
}

interface GPUExternalTexture {}

interface GPUBindGroupLayoutDescriptor {
  entries: GPUBindGroupLayoutEntry[];
}

interface GPUBindGroupLayoutEntry {
  binding: number;
  visibility: number;
  buffer?: { type: string };
}

// WebGPU constants
declare const GPUBufferUsage: {
  MAP_READ: number;
  MAP_WRITE: number;
  COPY_SRC: number;
  COPY_DST: number;
  INDEX: number;
  VERTEX: number;
  UNIFORM: number;
  STORAGE: number;
};

declare const GPUShaderStage: {
  VERTEX: number;
  FRAGMENT: number;
  COMPUTE: number;
};

declare const GPUMapMode: {
  READ: number;
  WRITE: number;
};

// Extend Navigator
interface Navigator {
  gpu: GPU;
}
