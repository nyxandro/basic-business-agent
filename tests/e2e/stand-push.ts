// The fake push service of the browser stand (tests/e2e/stand.ts): Ольга's «phone» is subscribed there, and scenarios
// read what it got from GET /received. Not one of the ports the server tests take (39997–39999).
export const STAND_PUSH_PORT = 39990;
export const STAND_PUSH_RECEIVED = `http://127.0.0.1:${STAND_PUSH_PORT}/received`;
