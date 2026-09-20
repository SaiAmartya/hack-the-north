# Wandduel pixel art direction

## Style formula

Original 16-bit handheld RPG pixel art, deliberately chunky square pixels and carefully placed clusters, crisp dark outlines with stepped silhouettes. Environment uses midnight indigo, muted slate and dusty lavender; friendly student wizards contrast in warm burgundy or sea teal with ivory faces and brass trim. Moonlight and small amber lamps create a welcoming magical academy after dusk. Preserve strong subject separation, readable wand silhouettes and restrained detail, with a consistent three-quarter battle perspective.

## Composition and references

- The [official FireRed/LeafGreen screenshot gallery](https://www.pokemon.com/us/pokemon-video-games/pokemon-firered-version-and-pokemon-leafgreen-version) and [official Ruby/Sapphire gallery](https://www.pokemon.com/us/pokemon-video-games/pokemon-ruby-version-and-pokemon-sapphire-version/) are the battle-UX references. The interpretation used here is an offset near/far combatant arrangement, separated health panels, a quiet central field, and a concise lower command strip.
- Near player: back visible, lower left, slightly larger. Far rival: face visible, upper right. Wand tips aim into the central negative space. The wizard clothing and academy are original; no franchise character, crest, logo, copied sprite or music is used.
- Local assets have no runtime service dependency. A cream and ink panel system should remain readable above the muted field. Red, cyan, amber, orange and mint spell signals sit above the world, with labels as well as color.
- No asset includes text, health bars, spell controls or decorative UI baked into the bitmap.

## Generation record

Model: Higgsfield Nano Banana 2, 1k output. The exact style formula above is included verbatim in each prompt. Background is 16:9; both characters are square with a uniform bright green key backdrop. Final character delivery must have actual alpha, not a checkerboard picture.

The supplied game-generation stylization reference says to get the style formula user-approved. The user explicitly fixed the pixel RPG direction and authorized expert decisions without extra approval; production continues with that instruction. The game-generation skill's deployment steps are not part of this asset-only task.

Exact prompts, returned model identity, accepted generation IDs and final dimensions are recorded in [asset-generation.json](asset-generation.json). The requested model is `nano_banana_2`; the completed jobs report `nano_banana_flash`. All three shipped files are in `apps/web/public/art/`.

## Asset verification

Inspected each original output and the final composite. Player is visibly back-facing and aims upper right; rival is visibly front-facing and aims lower left. Both share chunky silhouettes, dark outlines, brass trim and compact proportions. A second background generation removed misplaced baked-in circles so the game can place its own diagonal platforms. No further generations were needed.

Character keying removes all green-dominant pixels, including enclosed areas, before nearest-neighbor downsampling. Final PNGs have real alpha with the green fringe removed; neither contains a checkerboard background. The 64-color background is 235,028 bytes; player is 29,381 bytes and rival is 32,618 bytes, about 290 KiB for the whole pack. Keep `image-rendering: pixelated` on sprites. Do not soften them with CSS filters.

The courtyard floor begins around 60% image height. In an uncropped composition place the rival's feet around 64% height and player's feet around 90%, or shift the background upward if the far platform must be higher. Prefer player/rival rendered sizes around 280/210 pixels in a 960-pixel-wide arena. The transparent margins are intentional and protect the wand tips.

Asset-only visual inspection confirms artwork and alpha quality; runtime HUD alignment, responsive composition, hit effects and game-over screenshots remain the game integration checks.
