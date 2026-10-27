---
name: game-3d
description: 3D game builder. How the owner's 3D apps are made (Talenscape's city, the Lucky 7 slot machine, Tank): use when asked to make a 3D game, scene or interface, especially a phone PWA.
---

# 3D game builder: the process

The owner says what they want ("a 3D PWA game like X where you do Y"). This is how to get going in
the same direction as their other 3D apps, without them describing it again. Styling is their choice
each time; the process stays the same.

## The owner's direction (always)

- Real, lit 3D: glossy and metal materials, good light, reflections, a soft glow on bright parts.
  Not cel or cartoon shading unless they ask.
- Phone first: an installable PWA that works offline and runs smoothly on a phone; a computer is a bonus.
- Free only: no paid services, nothing that calls an AI, Cloudflare free plan for anything online.
- Nothing downloaded that someone else owns: shapes and patterns are made by code. Use images only
  if the owner made them or says where they're from.
- Plain words, a short plan, then "Do you want me to start?"; small steps; show a screenshot after each.

## 1. Pin the idea down (at most 3 questions)

Ask only what you can't guess: who plays and where (phone, TV, both); the goal and the one main
action (collect, race, spin, build, explore); the look (offer 3 to 5 named moods, below). Turn "like
X" into known choices: "like Crossy Road" = tap to move, endless lanes; "like a city builder" = plots
and roads (the Talenscape city); "like a slot machine" = one hero object, studio lights, big reveal;
"like an aquarium or Zelda" = a world to move through with a follow camera (Tank). Then a short plan.

## 2. Engine and setup

- Engine: three.js (the slot machine) or PlayCanvas (Talenscape, Tank). Both free (MIT). Pick
  three.js unless the project already uses PlayCanvas.
- Serve the engine from the app itself (bundled with esbuild, or copied into `vendor/`): no outside
  downloads at play time, so it works offline.
- One page, a full-screen canvas with `touch-action: none`, a small HUD over it, a manifest, an
  icon, and a service worker that keeps a copy of every file.
- If 3D can't start, show a plain sentence ("Sorry, this device can't show the game"), never a blank screen.

## 3. Build things from shapes (the kit)

- Like Lego: boxes, rounded boxes, cylinders and prisms, spheres, turned shapes (a side profile spun
  round, for domes, bottles and columns), tubes. Seeded random numbers, so the same name always builds
  the same object.
- Assemble each object from parts on a base (Talenscape: a platform with a glowing rim, tiers,
  ledges, light strips, antennas). Merge parts by material, so one building is a few draw calls.
- Many copies of one thing (coins, fish, coral, trees): instancing, one draw call for all of them.
- Bake shading into the shape where it's cheap: darker at the base and in crevices, lighter on tips (Tank's coral).

## 4. Surfaces and patterns

- Material families: lacquer paint (clear coat), metal, chrome, matte, glass, glow. Glow colours go
  above 1 so the bloom picks only them up.
- Patterns drawn by code on a canvas: window grids for lit windows, panel seams, ground tiles, road
  lines, warning stripes, noise. They tile seamlessly. Draw them once and reuse them.

## 5. Light and finish

- Hemisphere light plus one sun with soft shadows; a studio look adds spot or rect lights around the hero object.
- Reflections from a generated room environment (no image file). Keep its strength low outdoors, or
  dark glossy paint turns white.
- Film-like tone mapping (ACES or Filmic) and sRGB output. Then post effects on the higher quality
  levels only: bloom (threshold above 1, so only glow parts bloom), vignette, a light colour grade.
- A "look" (world) is one settings object: sky gradient, fog, light colours and power, reflection
  strength, exposure, bloom, a paint palette, glow colours. Switching it changes the whole mood.
  Examples: studio (glossy showroom), sunny, neon night (Talenscape), ocean (Tank), toy.

## 6. Layout (for worlds and boards)

Plots spiral out from a centre without overlapping; groups get their own wedge (neighbourhoods); roads
join each plot to its nearest neighbour so everything connects; small things scatter in the gaps,
clear of plots and roads. All seeded, so the same list gives the same map.

## 7. Controls, camera and feel

- Phone: drag on the left half is a thumb stick, drag on the right turns the camera, a quick tap
  picks the object under the finger (it opens a card, like a Talenscape building). Keyboard too.
- Follow camera behind and above, eased (damped) so it feels smooth; drag to look, it eases back.
- Sounds made by code (short tones, no audio files), a buzz on phones (skipped when "reduce motion" is
  on), progress and settings saved on the device, a menu with look, quality and sound.

## 8. Smooth on a phone

- Quality levels (low, medium, high; Tank has ultra): pixel ratio, shadows and shadow size, post
  effects. Start from a guess for the device, step down by itself when frames get slow, remember a
  level the player chose.
- `?debug` shows fps, level, draw calls and triangles. Watch draw calls (merge and instance) and
  triangles (fewer sides on small things).

## 9. Check it, every step

- `?shot` gives a fixed camera with the HUD hidden: take a screenshot with Playwright (it's installed)
  and look at it before telling the owner it works. Check each look and each quality level: what
  looks right on medium can wash out on high.
- Test the maths and the game rules with plain tests; test the look with screenshots.
- On the owner's phone: install it, turn on airplane mode, open it again.

## 10. Build order

1. Empty scene in the chosen look, with the camera and controls working. Screenshot.
2. The main object or player from the kit. 3. The world or board (layout). 4. The one main action
and its rules, with sound and buzz. 5. Score, saving, menu. 6. Quality levels and the phone check.
7. PWA install and offline. Show the owner after each step, and ask before anything goes online.
