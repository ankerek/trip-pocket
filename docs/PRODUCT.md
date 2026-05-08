# Trip Pocket

**Working name** · *Your pocket for travel ideas*

## The one-liner

Trip Pocket helps you capture travel inspiration the moment you see it, and actually find it again when you need it.

## Why this exists

Travel inspiration today lives on Instagram, TikTok, and YouTube. You scroll, you see a place that looks incredible, you screenshot it. Then it goes into your camera roll — alongside grocery lists, memes, and 4,000 other photos.

By the time you're actually planning a trip, those screenshots are buried. You scroll for ten minutes trying to find that café you saw three months ago. Most of the time you give up. The travel idea is gone.

This is a digital junk drawer problem, not a travel-planning problem. The ideas already exist — they just get lost.

## The insight

People don't need a better travel planner. There are dozens of those. What's missing is something one step earlier: a way to *catch* travel ideas when they appear, before they vanish into the camera roll.

Trip Pocket is the layer in between social media and any planner you eventually use. It's where ideas land and stay findable.

## What it is

Trip Pocket is a dedicated inbox for travel screenshots, with an AI layer that turns those screenshots into places you can actually use.

The default capture path is invisible: keep screenshotting on Instagram or TikTok like you always do, and Trip Pocket surfaces new screenshots when you open the app, ready to be sorted into a trip. When you want to be deliberate, you can also send a screenshot in via the share sheet, or pull from your camera roll from inside the app.

Either way, the screenshot lands in a trip you're collecting (e.g. "Japan 🇯🇵") and gets tagged as a place, food, or activity. AI reads the screenshot and pulls out the place name and city, so a picture of "Maru Tonkatsu, Shibuya" becomes a tappable place — one tap opens Google or Apple Maps. Later, when you're actually planning, everything is there — sorted, scannable, not lost.

Capture should feel as fast as taking a screenshot. Browsing should feel as clean as a Pinterest board. The AI does the boring part you would have skipped anyway.

### Why not just…

- **Apple Photos albums?** Screenshots mix in with everything else, there's no concept of a trip, and nothing is tagged. Photos is for memories, not future plans.
- **Pinterest?** Pinterest is for discovering other people's content. Trip Pocket is for keeping the things *you've* already found, in the format you found them in — the screenshot itself.
- **A travel planner like Wanderlog or a Notion doc?** Too much friction. They want structured input — names, addresses, dates. Trip Pocket only asks for a screenshot and a trip name.

## Who it's for

Frequent travelers who get most of their inspiration from social media. Millennials and Gen Z who already screenshot constantly. Digital nomads and remote workers planning their next stop. Anyone who has ever opened Photos, scrolled for ten minutes looking for that one place, and given up.

The first user is anyone with a camera roll full of screenshots they meant to do something with.

## What's in the box

**At launch:**

- Automatic detection of new screenshots in the background, surfaced for review
- Import via the iOS share sheet
- Import from the camera roll inside the app
- Dedicated storage outside the camera roll
- Trip collections (e.g. "Japan", "Lisbon weekend")
- Manual tagging: place / food / activity
- On-device OCR so the text inside screenshots is searchable
- AI extraction of place names and cities from screenshots
- A "Places" view per trip that lists everything we've found
- Tap any extracted place to open Google or Apple Maps
- A clean list view to browse what you've saved

**Later:**

- Rich place cards — a real photo of the venue, a 1–2 sentence summary of what it is, and metadata like rating and hours, fetched on demand the first time you open a place. The screenshot you saved three months ago becomes "oh right, that's the cozy bakery I wanted to try" without re-opening the original.
- Smart suggestions ("Looks like a café in Tokyo")
- An in-app map view of saved places
- Itinerary generation from saved ideas
- Cloud sync across devices

*(Technical architecture and roadmap live in separate documents.)*

## How we win

Speed. Simplicity. The lowest possible friction between seeing a thing and saving it well — and an AI layer that takes care of the boring step you would have skipped.

What we are deliberately *not* building, at least not early:

- A complex itinerary planner
- Server-side product logic (the AI extraction proxy is a stateless passthrough; the app's source of truth stays on the device)
- Social or sharing features
- Booking integrations

Each of those is a tarpit. The wedge is *save it before it's lost*, and that's where focus stays.

## Business model

Paid subscription with a 7-day free trial. No free tier.

The app is behind a paywall from day one. Anyone can start a 7-day trial that unlocks the whole thing — capture, OCR-search, AI place extraction, the Places view, tap-to-open in Maps, unlimited trips. After 7 days the subscription auto-renews (monthly or yearly) unless the user cancels through the App Store.

The trial is the only on-ramp. The pitch: a week is enough to see whether the screenshots-to-places loop saves you the time it costs. People who get value will keep it; people who don't, won't.

Pricing (monthly + yearly) is decided at launch from beta data.

## Positioning

> Your pocket for travel ideas.
>
> Save travel inspiration before it gets lost.
>
> Turn screenshots into places you can actually use.
