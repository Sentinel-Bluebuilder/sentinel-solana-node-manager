# Third-party assets

Protocol logos bundled in the app (`src/renderer/public/brand/protocols/`). They identify which
protocol a node offers on the deploy screen; they are not our branding and don't suggest
endorsement. Files are bundled because the CSP blocks remote images. The tiles show each logo on
a white badge, so the light-background variants are used. Scaling is the only change.

| File | Source | Licence / policy | Changes | sha256 |
|---|---|---|---|---|
| `xray.svg` | github.com/XTLS/Xray-docs-next `docs/public/logo-light.svg` | CC-BY-SA-4.0 (Project X) | none | ab7b6a19… |
| `openvpn.svg` | openvpn.net/branding → Icon (`logo_dark` variant, for light backgrounds) | OpenVPN brand page: keep padding, never stretch, add effects, recolour or rotate. "OpenVPN" is a registered trademark of OpenVPN, Inc. | none | 66ece10d… |
| `hysteria2.svg` | github.com/apernet/hysteria-website `docs/assets/logo.svg` | MIT (apernet) | removed the file's own `prefers-color-scheme: dark` block, so the white badge always gets the dark mark | 206a0396… |
| `amneziawg.svg` | github.com/amnezia-vpn/amnezia-client `client/images/controls/amnezia.svg` (the project's own small mono icon) | GPL-3.0 (changes allowed); used only to identify the AmneziaWG protocol | fill `#CCCAC8` → `#45423F` so it reads on the white badge (colour only). Replaces the full wordmark, unreadable at tile size | 55689e71… |

`tests/unit/protocol-logos.test.ts` fails if a protocol tile names a logo file that is missing,
or if a protocol has no logo.
