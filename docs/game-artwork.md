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
out of board art; textual controls retain a dark contrast backing above it. `stretch`
is available for deliberately distortion-tolerant textures.

Missing or failed tile images show tile labels; player images fall back to default
icons or initials; board images fall back to a neutral surface. Replacing a failed
source retries rendering. No image is required to identify an action or state.

## Local verification

The development mock page `?localEvidence=gameplay` includes artwork samples and
pack/failure controls. These remain within the existing DEV + mock-only lazy
import boundary and are absent from the production bundle. Use the claim, kong,
and score scenarios to check real presentation actions and visible-only tiles.

### Recorded local evidence (2026-09-20)

Credential-free Vite mock fixture, issue #23 worktree, port 5178:

- Desktop 1280×900: jade and midnight loaded every rendered image successfully;
  no document overflow. Both packs changed faces, backs, board pattern, human/bot
  defaults, and shared icons together.
- Narrow 375×812 and 320×740: hand, public melds, reaction prompts, gallery, and
  score controls wrap. At 320px with a 15px scrollbar, both document client width
  and scroll width were 305px after removing the fixed body minimum width.
- Keyboard Enter on chow submitted the original `[44, 48]` reaction IDs and
  displayed “Response submitted.” Private discard submitted tile 55; concealed
  kong submitted `[72, 73, 74, 75]`; added kong retained its meld ID and tile 55.
  Self-drawn win opened the scored result, with total payments +0 and disabled
  discard controls. Keyboard focus remained visible around the tile button.
- Deliberately invalid PNG sources triggered actual image errors. Failed faces
  and backs became readable labels, player defaults became initials, and board
  images disappeared onto the neutral surface. The small “chrysanthemum flower”
  fallback measured 44.7px high inside a 51.2px face (no clipping). Re-selecting
  valid artwork restored images with zero failed images or remaining fallbacks.
- Highlighted small faces measure 32px inside a 38px tile with 3px dashed borders;
  the loaded image no longer obscures the state indicator. Light custom board
  art cannot remove the independent dark content backing.

The current stack is based on #24's main-compatible controller extraction.
Human and bot default components are covered independently; persistent bot-seat
identity integration awaits the canonical #21 implementation and #24's follow-up
integration. Autopilot on a human seat deliberately retains the human icon.
These checks are local presentation evidence, not Discord-proxied deployment or
server-authority evidence.
