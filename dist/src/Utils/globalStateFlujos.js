class GlobalState {
    state = {};
    get(prop) {
        return this.state[prop];
    }
    async update(keyValue) {
        Object.assign(this.state, keyValue);
    }
    getAll() {
        return this.state;
    }
    clear() {
        this.state = {};
    }
}
export const globalState = new GlobalState();
