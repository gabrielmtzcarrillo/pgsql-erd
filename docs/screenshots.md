# How the README screenshots are taken

For people and agents who need to retake or add a screenshot. The PNGs live in `docs/screenshots/` (English) and
`docs/screenshots/es/` (Spanish, same file names); `README.md` and `README-es.md` embed them.

**Status of this document.** Only `ef-import` is produced by a script in the repository, and the notes for it were
verified by running it. Everything else was reconstructed from the committed images, the README text and the git
history; it was *not* re-run. Where a step is a guess it says so. When you retake one of these, replace the guess
with what you actually did, and prefer adding it to `scripts/capture-screenshots.mjs`.

## Conventions

- **Size:** 1440 × 880 px, PNG, device scale factor 1. The ribbon shot is the top 118 px only.
- **Both languages:** every screenshot exists twice. Language and theme come from `settings.json` in the app's user
  data folder: `{ "locale": "en" | "es", "theme": "white" }` (see the top of `src/main/main.cjs`). Use a throw-away
  folder with `--user-data-dir=<dir>` so the real settings are untouched.
- **Theme:** `white`, except the themes shot.
- **Sample data:** the diagram shots open `samples/shop.pgerd` (`npm start -- samples/shop.pgerd`). The path shows in
  the status bar, so run it from `D:\git\pgsql-erd`-style checkouts or accept that the path differs.
- **Database shots:** the committed images show a live connection `postgres@127.0.0.1:55432/shopdb`: a `shopdb`
  database with the `public` schema (`audit_log`, `customer`) and the `shop` schema (`coupon`, `order_item`, `orders`,
  `product`, `supplier`, `warehouse`), matching the sample diagram. pgvector and Apache AGE shots need those
  extensions installed in that database. None of this is created by the repository; set it up by hand.
- **Mouse pointer and caret:** not captured. Take shots with the DevTools protocol (below) rather than the OS screenshot
  tool and nothing stray ends up in them.

## Taking a shot by script (works today)

`scripts/capture-screenshots.mjs` starts Electron with `--remote-debugging-port=9333` and a temporary user data
folder, connects to the window over the Chrome DevTools protocol (Node's built-in `fetch` and `WebSocket`, no
dependencies), sets the viewport to 1440 × 880, runs the steps of a shot, calls `Page.captureScreenshot` and writes the
PNG for English and Spanish.

```bash
node scripts/capture-screenshots.mjs              # every scripted shot, both languages
node scripts/capture-screenshots.mjs ef-import    # one shot
node scripts/capture-screenshots.mjs --lang es    # one language
```

Add a shot by adding an entry to `SHOTS` in that script. Each entry gets `eval(js)` (runs in the page), `wait(ms)` and
`shot(fileName)`. Drive the app by calling its own commands or dispatching DOM events; native file dialogs cannot be
automated, so feed files in by dispatching a `drop` event with a `DataTransfer` that holds `File` objects (the window
accepts dropped `.pgerd`, spreadsheet, `.sql`, `.cs` and `.json` files). Look at the PNG afterwards.

Things learned while building it:

- Electron needs `--user-data-dir` to a fresh folder, otherwise it joins the running app through the single-instance
  lock.
- The first screenshot needs about 1.5 s after the window appears for the renderer to finish.
- The language is read at start-up, so a language switch means restarting the app (the script starts one per language).

## The shots

| File | What it shows | How |
| --- | --- | --- |
| `ef-import.png` | Import dialog on `docs/examples/ShopContext.cs`: six tables, SQL preview on the right | **Scripted** (`ef-import`). Drops the example file on an empty window, waits for the dialog |
| `diagram.png` | Diagram tab with the shop tables, the database explorer open on the left, connected | Not scripted. Connect to `shopdb`, open `samples/shop.pgerd`, show **Explorer**, zoom 120%, select nothing |
| `ribbon.png` | Top 118 px: the ribbon and the tab strip | Not scripted. Crop of a full window shot; ribbon with Database connected |
| `table-sidebar.png` | A table selected with its sidebar open (properties, columns, relationships) | Not scripted. Open the sample, click the `customer` header, click a column |
| `sql-preview.png` | The SQL preview panel next to the diagram | Not scripted. **SQL** button on the ribbon |
| `relationship.png` | The New relationship dialog with both ends filled in | Not scripted. Drag from a column's handle onto a column of another table |
| `themes.png` | One diagram in the four themes: White, Dark, Visual Studio, Windows ME, 2 × 2, each with a caption | Not scripted. Probably four window shots (View → Theme), 145% zoom, `customer` selected, combined into one image with the captions drawn on; the tool used for the composite is unknown |
| `db-explorer.png` | Explorer tree of the connected database | Needs the database |
| `query-builder.png` | Builder tab with a query built | Needs the database |
| `db-import.png` | Import from Database dialog | Needs the database (**Import** on the ribbon) |
| `db-compare.png` | Compare dialog with differences and migration SQL | Needs the database, with the diagram edited so there are differences |
| `scripts.png`, `scripts-in-diagram.png`, `commit-review.png` | Scripts tab, scripts shown in the diagram, commit review | Not scripted; needs the database for dry runs |
| `query-plan.png`, `pgvector-column.png`, `pgvector-query-plan.png` | Query analyzer and pgvector | Needs the database (pgvector for the last two) |
| `data-filter.png` | Data tab with an Excel-style filter menu open | Needs the database |
| `assistant.png` | Assistant tab | Needs an AI provider (Ollama, vLLM or OpenAI-compatible) configured |
| `age-relationships.png`, `age-explorer.png` | Apache AGE relationships and the Graph tab | Needs a database with AGE |

The Spanish shot of each row is the same steps with `"locale": "es"`.

## After retaking

1. Open the PNGs and check them: no cut-off dialog, no stale path in the status bar, same size as before
   (`file docs/screenshots/<name>.png` should say 1440 x 880).
2. Check that the README text next to the image still describes what it shows (`README.md` and `README-es.md`).
3. Commit the PNGs of both languages together.
