// globalState.ts
type GlobalStateType = Record<string, any>;

class GlobalState {
  private state: GlobalStateType = {};

  get(prop: string) {
    return this.state[prop];
  }

  async update(keyValue: GlobalStateType): Promise<void> {
    Object.assign(this.state, keyValue);
  }

  getAll(): GlobalStateType {
    return this.state;
  }

  clear(): void {
    this.state = {};
  }
}

export const globalState = new GlobalState();
