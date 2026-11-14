# ⸸ The Void Order

The Void Order's add-on for Bondage Club: orders and photo sessions from the hierarchy, the member list, ID cards, and
joining with the Order's questions.

**[Install it](https://proudkiller0015.github.io/void-order/install.html)**: a bookmark (no extension, phones too) or a
userscript. It always runs the newest version: both only load `void.js` from this repo's GitHub Pages every time the game
opens.

## Using it

Type `/void` in a chat room, or click the ⸸ tab on the left of the screen.

- **Orders**: orders, photo sessions and notices from the hierarchy. They only go down the ladder: to everyone below
  the sender, or to ranks and members below them. Answer an order with _Read_ or _Done_, and a session with _Coming_,
  _Maybe_ or _Can't come_. You get a reminder 15 minutes before a session, and again when it starts. Whoever sent it,
  and everyone above them, sees the answers.
- **Members**: everyone by rank, who's online, and which public room they're in. Click someone for their ID card.
- **The Order**: the about page and the rank ladder. The founder hands the Order over from here.
- **My card**: your bio and picture, and **Show my ID in this room**. Everyone in the room sees an emote; everyone with
  the add-on also gets your card.
- `/void card <member number>` opens someone's card; `/void id` shows yours to the room.

Not a member yet? `/void` shows the about page, the heads of the Order, and the joining questions.

## The hierarchy

Ranks go from the top down. The founder stands above every rank. Each rank can have any of three rights:

- **approves members**: lets applicants in, or turns them down;
- **gives orders**: posts orders, sessions and notices to everyone below them, or to ranks and members below them;
- **manages**: gives ranks and titles, removes members, makes reset codes, and edits the about page, the joining
  questions and the ranks.

You only act on members below you, only give ranks below your own, and only send orders down. Ranks at or above yours
are locked for you.

A member number and name are only what the applicant's game says, so whoever lets people in checks them in the game
first.

## Keys and devices

Each member signs in with a key kept in their BC account's add-on settings, so the same account works on every device.
Someone who loses their key (another browser before the account synced, a wiped account) asks someone above them for a
**reset code**: _Manage_ › their name › _Reset code_. They enter it under `/void`. It works once, for 48 hours.

## The server

`server/` is a Cloudflare Worker with one Durable Object that holds the Order: members, ranks, applications, the newest
300 orders, and a log of changes. Rooms and who's online are never stored. Private rooms are never sent.

```sh
cd server
npm install
npm run dev:test     # a local server (founder 11, founding code test-founding-code, any origin)
node test-server.js  # members, ranks, applications, orders, cards, reset codes, kicks, limits
npm run deploy
```

The founder's member number is `FOUNDER` in `wrangler.toml`. Founding also takes the `FOUND_CODE` secret
(`npx wrangler secret put FOUND_CODE`), since the server can't check a member number by itself. If the founder loses
their key, set an `OPERATOR_KEY` secret (32+ characters) and ask for a code:
`curl -X POST -H "Authorization: Bearer <key>" -d '{"member":<number>}' https://<worker>/op/reset`.

## Checks

```sh
npm install
npm run check   # prettier + eslint
BC_ROOT=<Bondage Club checkout>/BondageClub CHROME=<chrome executable> node test.js
```

`test.js` plays the real game headless against the local server (`npm run dev:test` in `server/`): founding, joining,
ranks, orders, cards, reminders. `SHOTS=1` saves a picture of each tab to `shots/`.
