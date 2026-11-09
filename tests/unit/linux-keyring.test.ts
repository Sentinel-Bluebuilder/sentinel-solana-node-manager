import { describe, expect, it } from 'vitest';
import { linuxPasswordStore } from '../../src/main/services/linux-keyring';

// ─── Linux keyring choice ───
// Bug: on Sway/i3/headless sessions Electron used its basic_text store, so the wallet
// was refused although gnome-keyring was running (2026-10-24 test pass).

const bus = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' };

describe('linuxPasswordStore', () => {
  it('asks for libsecret on a desktop Electron does not recognise', () => {
    expect(linuxPasswordStore('linux', { ...bus, XDG_CURRENT_DESKTOP: 'sway' }, [])).toBe('gnome-libsecret');
    expect(linuxPasswordStore('linux', bus, [])).toBe('gnome-libsecret');
  });

  it('leaves KDE to kwallet', () => {
    expect(linuxPasswordStore('linux', { ...bus, XDG_CURRENT_DESKTOP: 'KDE' }, [])).toBeUndefined();
    expect(linuxPasswordStore('linux', { ...bus, DESKTOP_SESSION: 'plasmawayland' }, [])).toBeUndefined();
  });

  it('keeps a store chosen on the command line', () => {
    expect(linuxPasswordStore('linux', bus, ['--password-store=basic'])).toBeUndefined();
    expect(linuxPasswordStore('linux', bus, ['--password-store', 'kwallet5'])).toBeUndefined();
  });

  it('does nothing without a session bus or off Linux', () => {
    expect(linuxPasswordStore('linux', { XDG_CURRENT_DESKTOP: 'sway' }, [])).toBeUndefined();
    expect(linuxPasswordStore('win32', bus, [])).toBeUndefined();
    expect(linuxPasswordStore('darwin', bus, [])).toBeUndefined();
  });
});
