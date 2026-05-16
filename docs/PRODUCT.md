# Trip Pocket

**Working name** · _Your pocket for travel ideas_

## The one-liner

Trip Pocket helps you capture travel inspiration the moment you see it, and actually find it again when you need it.

## Why this exists

Travel inspiration today lives on Instagram, TikTok. You scroll, you see a place that looks incredible, and you either screenshot it or tap "Save" inside the app. Either way it disappears — the screenshot goes into your camera roll alongside grocery lists, memes, and 4,000 other photos; the saved post goes into a flat, unsortable list inside Instagram or TikTok that you'll never open again.

By the time you're actually planning a trip, those screenshots are buried and those saved posts are unreachable. You scroll for ten minutes trying to find that café you saw three months ago. Most of the time you give up. The travel idea is gone.

This is a digital junk drawer problem, not a travel-planning problem. The ideas already exist — they just get lost.

## The insight

People don't need a better travel planner. There are dozens of those. What's missing is something one step earlier: a way to _catch_ travel ideas when they appear, before they vanish into the camera roll.

Trip Pocket is the layer in between social media and any planner you eventually use. It's where ideas land and stay findable.

## What it is

Trip Pocket is a dedicated inbox for travel ideas — screenshots _and_ the Instagram and TikTok posts you'd otherwise lose inside those apps — with an AI layer that turns each one into a place you can actually use.

The capture path is the iOS share sheet, and it works on whatever you're looking at. Open a post in Instagram or TikTok and tap Share → Trip Pocket — we pull the post itself (image, video, caption) so you don't even need to screenshot it. See something elsewhere and screenshot it the old way? Share the screenshot from Photos the same way. Pick a trip, done — one extra tap on top of what you were going to do anyway. If you've already got a backlog of screenshots in Photos, you can also pull them in from inside the app.

Either way, the item lands in a trip you're collecting (e.g. "Japan 🇯🇵") and gets tagged as a place, food, or activity. AI reads the image and caption and pulls out the place name and city, so a TikTok of "Maru Tonkatsu, Shibuya" becomes a tappable place — one tap opens Google or Apple Maps. Later, when you're actually planning, everything is there — sorted, scannable, not lost.

Capture should feel as fast as taking a screenshot. Browsing should feel as clean as a Pinterest board. The AI does the boring part you would have skipped anyway.

### Why not just…

- **Apple Photos albums?** Screenshots mix in with everything else, there's no concept of a trip, and nothing is tagged. Photos is for memories, not future plans.
- **Instagram or TikTok's Saved tab?** Saves are trapped inside each app, can't be grouped by trip, can't be searched by place, and you have to remember which app you saved it in. Trip Pocket pulls the post out and turns it into a place you can actually act on.
- **Pinterest?** Pinterest is for discovering other people's content. Trip Pocket is for keeping the things _you've_ already found, in the format you found them in — the screenshot or the original post.
- **A travel planner like Wanderlog or a Notion doc?** Too much friction. They want structured input — names, addresses, dates. Trip Pocket only asks for a share and a trip name.

## Who it's for

Frequent travelers who get most of their inspiration from social media. Millennials and Gen Z who already screenshot constantly — or who tap "Save" inside Instagram and TikTok and never see those saves again. Digital nomads and remote workers planning their next stop. Anyone who has ever opened Photos, scrolled for ten minutes looking for that one place, and given up.

The first user is anyone with a camera roll full of screenshots — or a hidden Instagram/TikTok saved tab — full of things they meant to do something with.

## What's in the box

**At launch:**

- Import via the iOS share sheet (with a trip picker inside the extension itself, so capture-to-trip is one tap from Photos)
- Share directly from Instagram and TikTok — share a post (including IG carousels and TikTok slideshow posts) to Trip Pocket as a URL and we fetch the media and caption automatically, so you skip the screenshot entirely. Tap the saved item to jump back into the original IG or TikTok post.
- Import from the camera roll inside the app
- Dedicated storage outside the camera roll
- Trip collections (e.g. "Japan", "Lisbon weekend")
- A places-first home — every screenshot or shared post becomes a place tile, filterable by trip or by what's still untriaged
- A triage flow for sorting new captures into trips one at a time, with multi-place selection per source
- On-device OCR — including all slides of an IG carousel or TikTok slideshow — so the text behind the image is searchable
- AI extraction of place names, cities, countries, and a six-bucket category (food / drinks / stays / sights / activities / shops) from screenshots and shared posts. The category icon is visible on every tile.
- Rich place cards — a real photo of the venue, a 1–2 sentence summary of what it is, address, rating, and price level, fetched on demand the first time you open a place. The screenshot you saved three months ago becomes "oh right, that's the cozy bakery I wanted to try" without re-opening the original.
- A "Places" view per trip that lists everything we've found, grouped by country for multi-country trips
- Tap any extracted place to open Google or Apple Maps
- Search across place names, cities, countries, descriptions, addresses, and the OCR text + captions behind the captures that produced them

**Later:**

- Smart suggestions ("Looks like a café in Tokyo")
- An in-app map view of saved places
- Itinerary generation from saved ideas
- Cloud sync across devices

_(Technical architecture and roadmap live in separate documents.)_

## How we win

Speed. Simplicity. The lowest possible friction between seeing a thing and saving it well — and an AI layer that takes care of the boring step you would have skipped.

What we are deliberately _not_ building, at least not early:

- A complex itinerary planner
- Server-side product logic (the AI extraction proxy is a stateless passthrough; the app's source of truth stays on the device)
- Social or sharing features
- Booking integrations

Each of those is a tarpit. The wedge is _save it before it's lost_, and that's where focus stays.

## Business model

Paid subscription with a free trial on every plan. No free tier.

The app is behind a paywall from day one. Two plans, both with an introductory free trial:

- **Yearly · $39.99/yr · 7-day free trial.** The lead offer — a week is enough to see whether the screenshots-to-places loop saves you the time it costs.
- **Weekly · $3.99/wk · 3-day free trial.** The low-commitment way in for people planning a single upcoming trip.

Monthly was dropped from the original plan: the yearly is the value plan, the weekly is the low-commit plan, and a middle tier would just split conversion. After the trial the subscription auto-renews unless cancelled through the App Store.

If a subscription lapses (trial ended without conversion, paid sub cancelled, billing failed) we don't wipe anything — local data is preserved and the app stays open in a read-only state, with the paywall one tap away. Resubscribing restores extraction, enrichment, and new captures without data loss.

## Positioning

> Your pocket for travel ideas.
>
> Save travel inspiration before it gets lost.
>
> Turn screenshots into places you can actually use.
