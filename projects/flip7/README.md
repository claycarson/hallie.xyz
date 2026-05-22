# Flip 7

A single-page scoresheet and calculator for the card game Flip 7.

## Features

- **Setup flow** — add 1–12 named players before starting
- **Card selection** — tap cards 0–12 to build your hand
- **Bonus cards** — 2× multiplier and +2, +4, +6, +8, +10 flat bonuses
- **Flip 7 bonus** — selecting 7 cards automatically adds +15 and triggers a rainbow alert
- **Live math** — formula display shows the full scoring breakdown as you select cards
- **Calculated + Override fields** — auto-computes your score, or manually enter one to override
- **Bust button** — record a 0 with one tap
- **Score table** — running totals with inline editing of past round scores
- **In-round scoreboard** — full standings visible while entering each player's score
- **Win condition** — first to 200 points wins; ties broken by highest total
- **Two themes** — toggle between a retro Mac (system.css) theme and a rainbow unicorn space theme

## Scoring Rules

1. Sum your card values
2. Apply 2× multiplier (if held) to the card sum only
3. Add flat bonus cards (+2, +4, +6, +8, +10)
4. Add +15 if you collected exactly 7 cards (Flip 7 bonus)

## Themes

Click the 🦄 / 🖥️ button in the header to switch themes. Your preference is saved automatically.

- **Classic** — Apple System 6 retro aesthetic via [system.css](https://github.com/sakofchit/system.css)
- **Unicorn** — Rainbow gradients, animated stars, and glassmorphism

## Files

| File | Description |
|------|-------------|
| `index.html` | Main app — all game logic and HTML |
| `theme-classic.css` | Retro Mac theme styles |
| `theme-unicorn.css` | Rainbow unicorn space theme styles |
