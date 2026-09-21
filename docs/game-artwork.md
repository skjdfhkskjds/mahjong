# Game artwork

The application selects its artwork once in
`apps/discord-activity/src/client/app/game-asset-selection.ts` and provides it
through `GameAssetsProvider` in the bootstrap composition. Presentation components
consume that resolved `GameAssetSet`; they do not choose packs. Artwork does not
change commands, rules, identity, the protocol, or persisted state.

## Contract and semantic keys

`presentation/assets/game-asset-set.ts` defines:

- `tiles.faces`: keys such as `suited:circles:5`, `wind:east`, `dragon:red`,
  `bonus:flower:bamboo`, and `bonus:season:spring`; `tiles.back` covers hidden tiles.
- `board.surface`: table artwork behind the existing layout.
- `players.human` and `players.bot`: default icons, separate from display names
  and optional per-player avatars.
- `icons.winds`: east/south/west/north; `icons.turn`; `icons.actions`:
  draw/discard/chow/pung/kong/win/pass.

Every entry is optional so incomplete packs have readable fallbacks. `Artwork`
contains `src`, positive intrinsic `width`/`height`, and optional `fit`:
`contain` (default), `cover`, or `stretch`. Use trusted, bundled SVG or raster
assets. No image upload, remote pack loader, or user-facing theme preferences are
introduced. SVG data URLs in the samples are generated locally from fixed
artwork, not user input. Asset sources must be reachable under the deployed
Activity's asset/origin policy.

Tile keys derive from structured tile kinds only. A flower named bamboo differs
from the bamboo suit. The feature mapper resolves reaction-choice tile IDs
against the viewer-visible tiles already present in its projection; the artwork
layer never derives a face from a physical ID or parses a display string.

## Pack selection and overrides

Replace the exported selection at the composition point:

```ts
import { resolveGameAssetSet } from "../presentation/assets/game-asset-set.js";
import { sampleGameAssetSet } from "../presentation/assets/sample-asset-sets.js";

export const selectedGameAssets = resolveGameAssetSet({
  set: sampleGameAssetSet,
});
```

The default jade and sample midnight packs visibly change tile faces/backs,
board, players, winds, turn, and actions together. A complete replacement is not
silently filled from the default pack; omitted artwork uses component fallbacks.
To replace a single entry and an entire category while retaining the default:

```ts
import customEast from "./art/east.svg";
import { sampleGameAssetSet } from "../presentation/assets/sample-asset-sets.js";

export const selectedGameAssets = resolveGameAssetSet({
  overrides: {
    tiles: {
      faces: {
        "wind:east": { src: customEast, width: 72, height: 100 },
      },
    },
    players: sampleGameAssetSet.players,
  },
});
```

Overrides merge category entries without mutating either pack. They can also be
applied on top of a replacement `set`. Keep resolved selections outside render
when static. Identity data and user avatars are passed to `PlayerIcon` separately;
an avatar failure falls through the selected default icon, then initials.

## Layout and accessibility

`Tile` is artwork only; button owners retain commands, disabled states, keyboard
activation, and focus. It supports small/medium size, upright/sideways orientation,
selected outlines, and highlighted dashed borders. Layout reserves the rotated
footprint, avoiding overlap. Named tile wrappers expose readable kinds; internal
images are decorative. Shared game icons accompany visible labels.

Tile slots are approximately 5:7, with 38px or 58px widths; sample art is 72×100.
Supply upright artwork; sideways rotates it clockwise by 90 degrees. `contain`
keeps artwork uncropped; raster resolution should suit the largest intended slot
and device pixel ratio. Icons use square slots (22px shared icons, 36px players).
Board art fills its container using its `fit` value: the samples use `cover`,
which can crop edges as the table changes aspect ratio. Keep meaningful content
out of board art; textual controls remain on opaque surfaces above it. `stretch`
is available for deliberately distortion-tolerant textures.

Missing or failed tile images show tile labels; player images fall back to default
icons or initials; board images fall back to a neutral surface. Replacing a failed
source retries rendering. No image is required to identify an action or state.

## Local verification

The development mock page `?localEvidence=gameplay` includes artwork samples and
pack/failure controls. These remain within the existing DEV + mock-only lazy
import boundary and are absent from the production bundle. Use the claim, kong,
and score scenarios to check real presentation actions and visible-only tiles.
