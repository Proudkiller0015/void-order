# ⸸ Oculus Nihili

Oculus Nihili, the Eye of the Void: the Void Order's add-on for Bondage Club. Orders and photo sessions from the hierarchy, the members by branch and rank,
ID cards in the Order's own format, joining, and Void dice that everyone in the room sees roll.

**[Install it](https://proudkiller0015.github.io/void-order/install.html)**: a bookmark (no extension, phones too) or a
userscript. It always runs the newest version: both only load `void.js` from this repo's GitHub Pages every time the game
opens.

## Using it

Type `/void` in a chat room, or click the ⸸ tab on the left of the screen.

- **Orders**: orders, photo sessions and notices from the hierarchy. They only go down: to everyone below the sender,
  or to branches, ranks, chapters and members below them. Answer an order with _Read_ or _Done_, and a session with
  _Coming_, _Maybe_ or _Can't come_. You get a reminder 15 minutes before a session, and again when it starts. Whoever
  sent it, and everyone over them, sees the answers.
- **Members**: the Founder and the Monsignors, then each branch by rank from 5 down to 1, then those awaiting a place;
  who's online, and which public room they're in. Click someone for their ID card.
- **The Order**: the about page, the branches with their ranks and chapters, and the hybrid titles. The Founder hands
  their place over from here.
- **Dice**: the Void dice (below).
- **Manage**: for the Founder, admins and branch leaders (below).
- **My card**: your bio and picture, the form of your rank names (feminine, masculine or neutral), your element if your
  rank has one, and **Show my ID in this room**. Everyone in the room sees an emote; everyone with the add-on also gets
  your card.
- `/void card <member number>` opens someone's card; `/void id` shows yours to the room; `/void roll 2d6+3` rolls.

Not a member yet? `/void` shows the about page and who leads, and **Join the Order** lets you in at once. An admin or a
branch leader then gives you your place.

## The Order

- **Five branches**, each with five ranks (1 at the bottom, 5 at the top): Priest ☨✙☨, Inquisitor ≈][≈, Paladin ✦⸸✦,
  Mage ☿⸸☿ and Maid 🧹. Many ranks have a feminine and a masculine name (Priest / Priestess, Maid / Butler), and each
  member picks their form. Mages pick their element for rank 3 (Pyromancer, Geomancer…).
- **Chapters**, three per branch, open from rank 2. A chapter can have its own rank names: the Mage chapters do
  (Spellblade, Cerebralist, Shaper and the ranks above them).
- **Hybrids**: a member in two branches holds the title for that pair (Priest + Paladin: Cleric, Inquisitor + Paladin:
  Commisar…).
- **Monsignor** 🎇: an honorary rank for BC celebrities who are full members. It gives no powers.
- **ID cards** follow the Order's format: _Praise the Void! 𓁹‿𓁹_, then _(Branch) - (Rank)_ and the chapter; a hybrid's
  card has their title, then each branch with its rank and chapter. _Copy ID_ copies it as text.

The branches, ranks, chapters, hybrid titles and symbols are the Order's own, written into the add-on; changing them is
an update.

## Who can do what

- **The Founder** (one member) and **the app admins** can do everything, everywhere: place anyone in any branch at any
  rank and chapter, make Monsignors, send orders to anyone, bring people in, remove members, and edit the about page and
  joining. Nobody acts on the Founder or an admin except the Founder. The Founder (and the member who
  runs the app) names the admins.
- **Branch leaders**, at rank 4 or 5 of a branch, place, promote, demote, set the chapter of, give orders to and take
  out the members of their branch whose rank there is below their own, and place members still awaiting a place. They
  remove someone from the Order only if they stand over them in every branch that person holds.
- **Everyone else** answers orders, keeps their card, and rolls dice.

A member number and name are only what the member's game says, so whoever places someone checks them in the game first.

## The Void dice

The **Dice** tab is a dice tray: d4, d6, d8, d10, d12, d20 and d100, up to ten at once, and a modifier. `/void roll`
takes the usual notation (`d20`, `2d6+3`, `3d6+1d4-2`). The Order's server rolls them, so nobody can fake a result. In a
chat room, everyone sees an emote with the result (no add-on needed), and everyone with the add-on watches the same dice
tumble and land in a small tray. A roll is only played if it is the sender's own and less than a minute old, and the tray
says when the roller had rolled again after it. Each member rolls at most 8 times a minute; the tray plays one roll at a
time.

## The Void mark

In a chat room, members who run the add-on carry a small Void mark over their character, so members spot each other on
sight: the Founder's 𓁹‿𓁹, a Monsignor's 🎇, or their branch's symbol (⸸ while they wait for a place). The mouse on it
shows their place; clicking it opens their ID card. Each add-on tells the room it is there with a hidden message when it
comes in, and the mark only shows for someone the Order knows as a member. Only members see the marks. _My card_ ›
_Settings_ turns them off.

## The Order chat in SlimeBeep

Members who also run [SlimeBeep](https://github.com/Proudkiller0015/slimebeep) are put in the Order's group chat there
once, when they first sign in as a member on a browser. Someone who leaves that group by themselves isn't put back; _My
card_ › _Join the Order chat in SlimeBeep_ joins it again on purpose. Members who leave or are removed from the Order are
taken out of it.

## Keys and devices

Each member signs in with a key kept in their BC account's add-on settings, so the same account works on every device.
Someone who loses their key (another browser before the account synced, a wiped account) asks someone over them for a
**reset code**: _Manage_ › their name › _Reset code_. They enter it under `/void`. It works once, for 48 hours.

Members the Order had before the add-on are brought in from _Manage_ › _Bring in existing members_, already placed; each
gets a join code, valid 7 days.

## The server

`server/` is a Cloudflare Worker with one Durable Object that holds the Order: members and their places, the structure,
the newest 300 orders, dice rolls for 10 minutes, and a log of changes. Rooms and who's online are never stored. Private
rooms are never sent.

```sh
cd server
npm install
npm run dev:test     # a local server (app admin 11, founding code test-founding-code, any origin, a stand-in relay)
node test-server.js  # joining, placing, branch leaders, hybrids, orders, cards, dice, the chat, codes, limits
npm run deploy
```

The app admin's member number is `ADMIN` in `wrangler.toml`: they found the Order, are its Founder until they hand that
place over, and keep every power after. Founding also takes the `FOUND_CODE` secret (`npx wrangler secret put
FOUND_CODE`), since the server can't check a member number by itself. If the Founder loses their key, set an
`OPERATOR_KEY` secret (32+ characters) and ask for a code:
`curl -X POST -H "Authorization: Bearer <key>" -d '{"member":<number>}' https://<worker>/op/reset`.

The Order chat takes the `SLIMEBEEP_LINK_KEY` secret, the same value as the SlimeBeep relay's `LINK_KEY`
(`npx wrangler secret put SLIMEBEEP_LINK_KEY`); `SLIMEBEEP_RELAY` in `wrangler.toml` is the relay's address. Without
the key, members are told the chat isn't set up yet.

## Checks

```sh
npm install
npm run check   # prettier + eslint
BC_ROOT=<Bondage Club checkout>/BondageClub CHROME=<chrome executable> node test.js
```

`test.js` plays the real game headless against the local server (`npm run dev:test` in `server/`): founding, joining,
placing, a branch leader's view, cards, orders, reminders and dice. `SHOTS=1` saves pictures to `shots/`.
