/** All production HTTP uses Electron's Chromium stack (system proxy/PAC support). */
export const electronFetch: typeof fetch = (input, init) => {
  const { net } = require("electron") as typeof import("electron");
  return net.fetch(input, init);
};
