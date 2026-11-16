/**
 * Before every test file (`bunfig.toml`'s preload): the token setting, so that whatever the tests run, a service they
 * spawn or the plugin they load included, keeps the store's token in memory (`token.ts`) and never asks the Keychain.
 */
export const testToken = "test-token-never-in-the-keychain";

process.env.DESK_TOKEN = testToken;
