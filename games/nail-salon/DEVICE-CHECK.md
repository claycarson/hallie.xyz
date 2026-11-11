# Device check (iPad)

Gate M0 passed 2026-11-11 (Clay). M1 is in progress; its steps are first, M0's are kept below.

**https://dev.hallie.xyz/?debug** (HTTPS dev copy of the `nail-salon` branch; not live).

If an old version shows, reload the page. Fingers: tap `f0`…`f4` in the debug panel (thumb to pinky).


## M1.1: all five nails (try when convenient; not blocking)
1. Open **https://dev.hallie.xyz/?view=hand&debug**. The whole hand shows, with a little hand map at
   the bottom left.
2. Tap any nail on the hand. The camera glides to it. Paint it.
3. Use the arrows beside the nail to go to the next one. The brush is full again each time.
4. Swipe sideways on empty background (off the finger). It moves one nail. A swipe that starts
   on the finger paints instead.
5. Tap a nail on the little hand map, then the map's palm (back to the whole hand). Painted
   nails fill in on the map; unfinished ones glow.
6. Go back to a nail you painted earlier. The paint is all still there and looks just as sharp.
7. Tap the arrows and the turn button with a finger right after using the Pencil. They work.
8. **Copy report** and paste it back: it now shows `paint … MB` and `switch … ms`.

# Gate M0 (done)

## On the Mac first
Open `~/Documents/Repositories/tasks/2026-11-10_nail-salon-mockups/anatomy-sheet/index.html`.
Our nail, bare and in red, beside real photos. **Sign off, or say what looks wrong.**

## Painting (Pencil)
1. Does the nail look like it grows out of the finger? Try `f0`, the thumb.
2. Hold the Pencil just above the nail. A small brush should float there with a soft shadow.
3. Paint. The brush should follow your tip with no lag, and lean the way the Pencil leans.
4. Does the polish lay down like a brush, not a spray?
5. Tilt the Pencil flat, then upright. The stroke gets wider, then narrower.
6. Rest your palm on the screen while painting. The palm must not paint. Also try: palm down
   *first*, then the Pencil (the Pencil must paint); palm resting near the round button and the
   bottle (nothing happens).
7. Paint until the bottle on the right pulses and the stroke goes thin. Tap the bottle. The next
   stroke goes on full again.
8. Put the Pencil down for a minute, then paint with a finger. It should work.

## Turning the hand
9. Tap the round button at the top right, with the two arrows. The nail spins a half turn.
10. Paint some, then turn. The paint must not change. Paint again from the other way.
11. Which way feels right to paint: fingertips down (the default) or up?
12. Reload the page. It should stay the way you left it.

## Looks
13. Tap `hand` in the debug panel, then Boutique, Candy Pop and Midnight Glam. Tap the turn button
    in hand view too.
14. Try `&polish=chrome-silver`, `&polish=glitter-gold`, `&polish=holo-lilac` on the end of the URL.

## Then
15. Tap **Copy report** and paste what it says back. It now has frame time, draw counts and boot time.
16. **Playtest 0:** Hallie paints for five minutes with no instructions. Note what she tries that
    doesn't work.

Useful URLs: `?scene=nail|hand` (fixed test views), `&theme=boutique|candy|midnight`,
`&shape=round|square|squoval|oval|almond|coffin|stiletto`, `&free=0…1`, `&flip=1`,
`&polish=cream-pink|glitter-gold|chrome-silver|holo-lilac|shimmer-pink`, `&debug=frames` (frame editor).
On the Mac: `npm run serve` in `games/nail-salon/`, then http://127.0.0.1:8813/?debug (mouse paints).
