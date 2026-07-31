export class AdapterRegistry {
  constructor(adapters = []) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.platform, adapter]));
  }

  get(platform) {
    const adapter = this.adapters.get(platform);
    if (!adapter) throw new Error(`No chat adapter configured for ${platform}.`);
    return adapter;
  }

  values() {
    return [...this.adapters.values()];
  }
}
