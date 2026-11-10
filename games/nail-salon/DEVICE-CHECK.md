# Device check (iPad)

**https://dev.hallie.xyz/?debug** (HTTPS dev copy of the `nail-salon` branch; not live).

Early look only, before the M0 gate. The real hand; one nail takes paint (the index finger,
or `&finger=0…4`, thumb to pinky). `?scene=hand&debug` shows the whole hand.
1. Does the nail look like it grows out of the finger?
2. Paint with the Pencil. Does it keep up with your hand? Does it lay down like a brush, not a spray?
3. Rest your palm on the screen while painting. The palm must not paint.
4. Put the Pencil down for a minute, then paint with a finger. It should work.
5. Tilt the Pencil flat, then upright. The stroke should get wider, then narrower.
6. Tap "Copy report" and paste what it says back.

On the Mac: `npm run serve` in `games/nail-salon/`, then http://127.0.0.1:8813/?debug (mouse paints).

Useful URLs: `?scene=nail|hand`, `&theme=boutique|candy|midnight`,
`&shape=round|square|squoval|oval|almond|coffin|stiletto`, `&free=0…1`, `&flip=1`,
`&polish=cream-pink|glitter-gold|chrome-silver|holo-lilac|shimmer-pink`.
