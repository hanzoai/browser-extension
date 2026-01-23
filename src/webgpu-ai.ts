// WebGPU AI Runner for Browser Extension
// Enables local AI inference directly in the browser

interface ModelConfig {
  name: string;
  url: string;
  quantization: '4bit' | '8bit' | 'fp16';
  maxTokens: number;
}

export class WebGPUAI {
  private device: GPUDevice | null = null;
  private models: Map<string, any> = new Map();
  
  async initialize(): Promise<boolean> {
    if (!navigator.gpu) {
      console.warn('[Hanzo AI] WebGPU not supported in this browser');
      return false;
    }
    
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) {
        console.warn('[Hanzo AI] No GPU adapter found');
        return false;
      }
      
      this.device = await adapter.requestDevice();
      console.log('[Hanzo AI] WebGPU initialized successfully');
      
      // Check for required features
      const features = adapter.features;
      console.log('[Hanzo AI] GPU Features:', Array.from(features));
      
      return true;
    } catch (error) {
      console.error('[Hanzo AI] WebGPU initialization failed:', error);
      return false;
    }
  }
  
  async loadModel(config: ModelConfig): Promise<void> {
    if (!this.device) {
      throw new Error('WebGPU not initialized');
    }
    
    console.log(`[Hanzo AI] Loading model: ${config.name}`);
    
    // Load model weights
    const response = await fetch(config.url);
    const modelData = await response.arrayBuffer();
    
    // Create GPU buffers for model
    const modelBuffer = this.device.createBuffer({
      size: modelData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    
    this.device.queue.writeBuffer(modelBuffer, 0, modelData);
    
    // Store model configuration
    this.models.set(config.name, {
      buffer: modelBuffer,
      config: config
    });
  }
  
  async runInference(modelName: string, input: string): Promise<string> {
    const model = this.models.get(modelName);
    if (!model || !this.device) {
      throw new Error(`Model ${modelName} not loaded`);
    }
    
    // Tokenize input
    const tokens = this.tokenize(input);
    
    // Create input buffer
    const inputBuffer = this.device.createBuffer({
      size: tokens.length * 4, // 32-bit integers
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    
    this.device.queue.writeBuffer(inputBuffer, 0, new Int32Array(tokens));
    
    // Create output buffer
    const outputBuffer = this.device.createBuffer({
      size: model.config.maxTokens * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    });
    
    // Create compute pipeline
    const pipeline = await this.createInferencePipeline(model);
    
    // Run inference
    const commandEncoder = this.device.createCommandEncoder();
    const passEncoder = commandEncoder.beginComputePass();
    
    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, this.createBindGroup(model, inputBuffer, outputBuffer));
    passEncoder.dispatchWorkgroups(Math.ceil(tokens.length / 64));
    passEncoder.end();
    
    this.device.queue.submit([commandEncoder.finish()]);
    
    // Read results
    const resultBuffer = await this.readBuffer(outputBuffer);
    const result = this.detokenize(new Int32Array(resultBuffer));
    
    return result;
  }
  
  private tokenize(text: string): number[] {
    // Simple tokenization - in production use proper tokenizer
    return text.split(/\s+/).map(word => this.hashCode(word));
  }
  
  private detokenize(tokens: Int32Array): string {
    // Simple detokenization - in production use proper detokenizer
    return Array.from(tokens).map(t => `token_${t}`).join(' ');
  }
  
  private hashCode(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }
  
  private async createInferencePipeline(model: any): Promise<GPUComputePipeline> {
    if (!this.device) throw new Error('Device not initialized');
    
    const shaderModule = this.device.createShaderModule({
      code: `
        @group(0) @binding(0) var<storage, read> model_weights: array<f32>;
        @group(0) @binding(1) var<storage, read> input_tokens: array<i32>;
        @group(0) @binding(2) var<storage, read_write> output_tokens: array<i32>;
        
        @compute @workgroup_size(64)
        fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
          let idx = global_id.x;
          if (idx >= arrayLength(&input_tokens)) {
            return;
          }
          
          // Simplified inference - real implementation would use proper transformer
          let token = input_tokens[idx];
          let weight_idx = token % arrayLength(&model_weights);
          let weight = model_weights[weight_idx];
          
          // Generate next token (simplified)
          output_tokens[idx] = i32(weight * f32(token));
        }
      `
    });
    
    return this.device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: shaderModule,
        entryPoint: 'main'
      }
    });
  }
  
  private createBindGroup(model: any, inputBuffer: GPUBuffer, outputBuffer: GPUBuffer): GPUBindGroup {
    if (!this.device) throw new Error('Device not initialized');
    
    const bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }
      ]
    });
    
    return this.device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: model.buffer } },
        { binding: 1, resource: { buffer: inputBuffer } },
        { binding: 2, resource: { buffer: outputBuffer } }
      ]
    });
  }
  
  private async readBuffer(buffer: GPUBuffer): Promise<ArrayBuffer> {
    if (!this.device) throw new Error('Device not initialized');
    
    const readBuffer = this.device.createBuffer({
      size: buffer.size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    
    const commandEncoder = this.device.createCommandEncoder();
    commandEncoder.copyBufferToBuffer(buffer, 0, readBuffer, 0, buffer.size);
    this.device.queue.submit([commandEncoder.finish()]);
    
    await readBuffer.mapAsync(GPUMapMode.READ);
    const data = readBuffer.getMappedRange().slice(0);
    readBuffer.unmap();
    
    return data;
  }
}