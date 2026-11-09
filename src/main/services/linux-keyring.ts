// ─── Linux keyring choice ───
// Pure helper (no Electron) so unit tests can load it directly.
//
// Electron picks the Linux key store from the desktop name: KDE → kwallet, GNOME and a
// few others → libsecret, anything else (Sway, i3, a headless or remote session) → its
// "basic_text" store, which safeStorage reports as unavailable. The wallet was then
// refused with "turn on a system keyring" although a keyring was running. Asking for
// libsecret on those desktops uses the running Secret Service (gnome-keyring, KeePassXC,
// …); with none running, safeStorage stays unavailable exactly as before.

/** The --password-store value to add at start-up, or undefined to leave Electron's choice. */
export function linuxPasswordStore(
  platform: string,
  env: Record<string, string | undefined>,
  argv: readonly string[],
): 'gnome-libsecret' | undefined {
  if (platform !== 'linux') return undefined;
  // The user (or a launcher) chose a store: keep it.
  if (argv.some((a) => a === '--password-store' || a.startsWith('--password-store='))) return undefined;
  // Secret Service lives on the session bus; without one there is nothing to talk to.
  if (!env['DBUS_SESSION_BUS_ADDRESS']) return undefined;
  // KDE gets kwallet from Electron's own choice.
  const desktop = `${env['XDG_CURRENT_DESKTOP'] ?? ''}:${env['DESKTOP_SESSION'] ?? ''}`.toLowerCase();
  if (/kde|plasma/.test(desktop)) return undefined;
  return 'gnome-libsecret';
}
