/** Settings wiring shared by the self-maintained DSH plugins.
 *
 * DSH 0.2 replaced `SettingsForms.register(ns, schema, …)` with profile-entry
 * Config derivation, which changes two things this shim must respect:
 *
 * - `describe()` publishes a namespace only when `volatileForm(Config)` is
 *   non-empty, i.e. when the schema carries at least one volatile field; a
 *   plain schema renders no settings page at all.
 * - The 0.1 helper `installSettingsSection` is gone from 0.2's `dsh-settings`.
 *   A plugin that still resolves an older copy of that package keeps the
 *   helper, and calling it against a 0.2 service throws inside an injected
 *   callback, where the host swallows the error silently — the plugin then
 *   shows neither a settings page nor a working custom card.
 *
 * So the switch is the live service surface (`ctx.settings.register`), never the
 * resolved module's exports, and Config stays volatile.
 */
import * as settings from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

export const settingsNamespace = settings.settingsNamespace ?? (name => name)

/** Mark every field volatile, the condition DSH 0.2 puts on publishing a settings page. */
export function liveConfig(schema) {
  return z.object(Object.fromEntries(Object.entries(schema.dict).map(([key, field]) => [key, field.volatile()])))
}

export const plainConfig = entry => Object.fromEntries(Object.entries(entry).map(([key, value]) => [key, typeof value?.get === 'function' ? value.get() : value]))

export function installSettingsSection(ctx, ns, schema, entry, hooks) {
  // 0.1 registers sections on the service; 0.2 derives them from the profile entry.
  if (settings.installSettingsSection && typeof ctx.settings?.register === 'function') {
    return settings.installSettingsSection(ctx, ns, schema, entry, hooks)
  }
  const read = () => plainConfig(entry)
  hooks.setSource(read)
  ctx.on('loader/volatile-update', () => {
    hooks.setSource(read)
    hooks.onChange()
  })
  ctx.inject(['settings'], child => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })
}
