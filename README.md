# Arch Diagram (hosted)

The hosted, multi-user version of [arch-diagram](https://github.com/avchaykin/arch-diagram), a web app for drawing architecture diagrams.
Create a diagram, share its link, and edit it together in real time.

## Sharing and co-editing

- **Create**: the start page creates a blank diagram, one from the example, or one imported from a `.json` file. Each diagram gets an unguessable id and its own link, `/d/<id>`.
- **Share**: the **Share** button copies the link. Anyone who opens it can view and edit the diagram. There are no accounts: the link is the key, so share it only with people who should have access.
- **Live editing**: changes appear for everyone as they are made, even during a drag. Two people can work on different elements at the same time. If they change the same property of the same element, the last change to reach the server wins, and all clients converge to it.
- **Presence**: you see the other people's avatars, pointers and selections in their color. Click your avatar to set your name and color. Click someone else's avatar to jump to their pointer.
- **Undo** reverts only your own changes and leaves the others' edits alone.
- **Saving** is automatic, on the server. The dot next to the name is green while connected. If the connection drops, you can keep working. Your changes are sent once it is back.
- **Files**: **Download** saves a JSON copy in the format of the stand-alone app. **Import**, or dropping a `.json` file on the window, replaces the content of the current diagram, and Undo brings it back.
- **Recent**: the start page lists the diagrams opened on this device.

## Running

Requires Node.js 18 or newer.

```sh
npm install
npm start                # http://localhost:3000
npm test                 # end-to-end check of the sync server
```

Environment variables:

| Variable   | Default   | Meaning                                  |
|------------|-----------|------------------------------------------|
| `PORT`     | `3000`    | HTTP port                                |
| `HOST`     | `0.0.0.0` | Interface to listen on                   |
| `DATA_DIR` | `./data`  | Where diagrams are stored, one JSON file per diagram |

With Docker:

```sh
docker build -t arch-diagram-hosted .
docker run -p 3000:3000 -v arch-data:/data arch-diagram-hosted
```

Any host that runs a Node process with WebSockets and a persistent disk works, for example Fly.io, Render, Railway or a VPS. Put it behind HTTPS: the client then uses `wss://` on its own.

## How it works

- `server.js`: a single Node process with plain `http` plus [`ws`](https://github.com/websockets/ws). It serves the pages, provides the REST API and runs one WebSocket "room" per diagram. While a diagram is open it is held in memory. It is written to `DATA_DIR/<id>.json` shortly after each change, and unloaded a minute after the last person leaves.
- `public/index.html`: the editor, which is the original single-file app with a sync layer added. After each change, the client compares the diagram with the last state it shared and sends only the differences as element-level operations: `add`, `set` (changed fields only), `del`, `order`, `settings` and `name`. The server applies them in arrival order, acks the sender and relays them to the others. If a remote change touches something this client has sent but has not had acknowledged yet, the client skips it. Its own change reaches the server later and wins there too, so everyone ends with the same diagram.
- `public/home.html`: the start page.

API:

| Method | Path | |
|---|---|---|
| `POST` | `/api/diagrams` | Create a diagram. Optional body: `{ "name": "…", "data": <arch-diagram JSON> }`. Returns `{ id, url }` |
| `GET`  | `/api/diagrams/:id` | The diagram as arch-diagram JSON (`?download` to get it as a file) |
| `WS`   | `/ws/:id` | Live session |
| `GET`  | `/healthz` | Health check |

## Editor features

- **Blocks**: size, fill, border style/color/width, corner radius, a rich-text title (bold, italic, colors, sizes, line breaks), an icon (built-in set or any emoji/text), and a badge plus an optional highlight ring.
- **Links**: **Shift + drag** from a block to another block, or onto empty canvas to leave a free end.
- **Connectors**: placed on a block side automatically and spread evenly when several share a side. The exception is a link whose blocks face each other, or whose free end lies in front of a side. It attaches straight across, with no bends, as long as that crosses no block and adds no crossings with other links. Several links between the same two sides run straight side by side. If not all of them fit in the shared part of the sides, as many as fit go straight and the rest are spread evenly around them. The same applies when a polyline already runs towards a side, for example after leaving another block upwards. Instead of ending with a small step onto its spread spot, the connector moves onto the line so the link enters straight. This also works for manually shaped polylines; their bends stay as they are. You can switch this per link with "Straight when possible" in the link's sidebar, set the default for new links in Settings, or turn it off for all links in Settings under Link routing. Drag a link end to another side, another block, or free space. Drop near a block's center to make the side automatic again. A connector can be simple, a circle or a square, in any color.
  When you select a block, the sidebar lists all its connectors. Each one shows the block at the other end, lets you change its side, and can be given a name. A "show" toggle turns the name on or off next to the connector.
- **Link ends**: none, full arrows (normal/narrow/wide), lined arrows (normal/narrow/wide), triangle, circle, square and diamond, in hollow or filled versions.
- **Routing**: curve, straight line or orthogonal polyline.
  - Polylines are routed with A* around blocks and keep a set clearance.
  - Polylines avoid overlapping each other. Parallel segments are spread apart by a set spacing.
  - Polyline corners are rounded with a set radius.
  - **Minimize bends**: a polyline with two or more bends becomes a single L-shaped bend when other sides or spots for its connectors allow it. As with straight links, this happens only if no block is in the way and no crossings are added. Sides you set by hand and manually shaped routes are kept. You can switch it per link, set the default for new links, or turn it off for all links in Settings.
  - You can drag any polyline segment to move it. Near the line of the neighbouring segments it snaps into line with them, which removes the step. The route then becomes manual: its bends stay where you put them and follow the ports when blocks move. Double-clicking a segment, or "Reset route" in the sidebar, brings back automatic routing.
- **Frames**: named areas that group blocks. They have a fill color and opacity, a border style, color and width, a name color and a corner radius, and are always drawn below blocks and links.
  - **Frame** in the toolbar wraps the selected blocks, or adds an empty frame.
  - Drag a frame by its name or border, and everything inside it moves along: blocks, nested frames and free link ends. The inside of a frame still works like empty canvas.
  - Frames can be resized, nested, copied (with their content) and deleted (the content stays).
- **Flows**: named sequences of numbered steps over blocks and links, such as a request path or a user scenario. They are managed in the **Flows** tab of the sidebar.
  - You can start with an empty flow, record one by clicking elements on the canvas in order, or build one from the current selection.
  - Steps can be added, deleted and dragged to a new order. The same element can appear in a flow several times.
  - A flow has a name, a description and a color, and each step has its own description.
  - Hovering a flow in the list previews its step numbers on the canvas. When a flow is open, its numbers stay visible. Click a number to jump to that step.
- **Settings**: canvas, grid and snap, routing parameters, and default styles for new blocks and links. You can save them as your personal defaults.
- **Export**: the Export menu saves the diagram as PNG or PDF in high resolution (3× by default, adjustable in Settings), or as a vector SVG. The PDF page matches the diagram's size and holds a lossless image. Selection and grid are left out; the open flow's step numbers are included.
- **Other**: undo/redo, copy/paste/duplicate, box selection, zoom/pan.

## JSON format

```json
{
  "app": { "name": "arch-diagram", "version": "1.0.0", "github": "https://github.com/avchaykin/arch-diagram" },
  "format": 1,
  "savedAt": "…",
  "settings": { "canvas": {}, "routing": {}, "block": {}, "link": {} },
  "view": { "x": 0, "y": 0, "k": 1 },
  "blocks": [ { "id": "b1", "x": 0, "y": 0, "w": 160, "h": 72, "title": "<b>API</b>", "icon": "server", "badge": "NEW" } ],
  "links":  [ { "id": "l1", "from": { "block": "b1", "side": "auto" }, "to": { "x": 300, "y": 40 }, "route": "poly", "endEnd": "arrow" } ],
  "frames": [ { "id": "fr1", "x": 0, "y": 0, "w": 400, "h": 260, "name": "Backend", "fill": "#eef2ff", "opacity": 40, "stroke": "#94a3b8", "strokeStyle": "dashed", "strokeWidth": 1.5, "textColor": "#475569", "radius": 12 } ],
  "flows":  [ { "id": "f1", "name": "Place an order", "description": "…", "color": "#7c3aed", "steps": [ { "ref": "b1", "description": "…" }, { "ref": "l1", "description": "…" } ] } ]
}
```

A link end is either attached, `{ "block": id, "side": "auto" | "top" | "right" | "bottom" | "left", "t": 0..1 }`, or free, `{ "x", "y" }`.
Any end can also carry a connector name: `"name": "REST /orders", "showName": true`.
A flow step's `ref` is the id of a block or a link.
A manually shaped polyline stores its bend points as `"waypoints": [ { "x", "y" }, … ]`.

## Shortcuts

| Action | Keys |
|---|---|
| New block | double-click canvas |
| Edit title | double-click block / Enter |
| New link | Shift + drag from block |
| Move a polyline segment | drag the segment |
| Reset an adjusted polyline | double-click a segment |
| Stop recording flow steps | Enter / Esc |
| Undo / redo | Ctrl/⌘+Z, Ctrl/⌘+Shift+Z |
| Copy / paste / duplicate | Ctrl/⌘+C / V / D |
| Download JSON / import JSON | Ctrl/⌘+Shift+S, Ctrl/⌘+O |
| Zoom | mouse wheel |
| Pan | drag empty canvas (or Space + drag) |
| Box select | Shift or Ctrl/⌘ + drag on empty canvas |
| Fit | F |
