import { Schema } from "effect"
import { Plugin, Store } from "@opencode/plugin/gui"
import { Vault, emptyVault, vaultVersion } from "./store"
import en from "./i18n/en"

export const definition = Plugin.define({
  stores: {
    vault: Store.global(Vault, emptyVault),
  },
  i18n: { en, "zh-TW": en, "zh-CN": en },
})

export type { Vault }
export { vaultVersion }
