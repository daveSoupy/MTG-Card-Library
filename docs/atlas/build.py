"""
Builds docs/atlas/codebase-atlas.html — the interactive codebase map.

    python3 docs/atlas/build.py

Reads every non-test source file under server/src and web/src, takes each
file's blurb from its leading /** comment (or FALLBACK below for files that
have none), resolves its relative imports, assigns it a layer, and injects the
result into template.html. Run it after adding, moving, or renaming a file;
commit the rebuilt page alongside. The "Where do I edit" list is TASKS below.

The built page is shaped for publishing as a Claude artifact (no doctype/head/
body of its own — the publisher adds them); browsers also open it straight from
disk. The live copy is https://claude.ai/artifact/N9RBn22L9gnfhJBtixrKLg —
republish there with the Artifact tool's `url` rather than creating a new one.
"""
import re, os, json, glob

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
os.chdir(ROOT)

def header_blurb(path):
    src = open(path).read()
    m = re.search(r'/\*\*\s*\n((?: \*.*\n)+?) \*/', src)
    if not m: return None
    text = ' '.join(l.strip().lstrip('*').strip() for l in m.group(1).splitlines())
    text = text.split('\n\n')[0]
    # first sentence-ish (up to first '. ' after 40 chars)
    m2 = re.match(r'(.{40,}?[.!?])(\s|$)', text)
    return (m2.group(1) if m2 else text)[:220]

FALLBACK = {
 'server/src/index.ts': 'Bootstrap: opens the DB, builds every store once, registers every route file, installs the error handler, serves web/dist, starts backups, listens.',
 'server/src/decks/store.ts': 'DeckStore — every deck read and write: list/get/create/update/duplicate/delete, add/set/remove a slot, board and category, tags, cover, recommended and auto-maintained lands. Every mutation ends by reconciling claims.',
 'server/src/decks/stats.ts': 'deckStats — mana curve (capped at 7), type breakdown, colour distribution, owned and proxied counts.',
 'server/src/decks/templates.ts': 'TemplateStore CRUD plus computeTemplateProgress — how a deck measures against a template\'s targets.',
 'server/src/decks/types.ts': 'Shared deck shapes: Board, FormatRules, DeckCard, Deck, DeckValidation, DeckStats.',
 'server/src/events/store.ts': 'EventStore — events (a draft night, linked to a cost pool and a deck) and the game log with W-L-D records.',
 'server/src/routes/cards.ts': 'GET /cards (search), /cards/random, /cards/:oracleId, PUT art preference, /sets, /formats.',
 'server/src/routes/collection.ts': 'Locations, lots, decrement, cost pools, value and snapshots, set completion, and a deck\'s shopping list.',
 'server/src/routes/decks.ts': 'Deck CRUD, slots, tags, cover, categories, buildability, and snapshots.',
 'server/src/routes/events.ts': 'Events and games CRUD; a deck\'s games.',
 'server/src/routes/presets.ts': 'Saved filter presets — an opaque JSON payload nothing queries inside.',
 'server/src/routes/settings.ts': 'GET/PUT /settings through the BOOLEAN / ENUM / NUMBER allowlists. A new setting is an entry here.',
 'server/src/routes/sync.ts': 'GET /status, POST /sync, POST /sync/categories, and the SSE progress stream.',
 'server/src/routes/templates.ts': 'Deck template CRUD and clone.',
 'server/src/routes/tradeLists.ts': 'Trade lists: lists, items, reorder, plaintext export.',
 'server/src/routes/trades.ts': 'Trades: drafts, items, cancel, complete.',
 'server/src/routes/wants.ts': 'Want lists: lists, items, reorder, lookup by oracle id.',
 'server/src/search/store.ts': 'CardSearchStore — search over FTS5 + trigram, card detail (faces, printings, legalities, rulings, owned/deck usage), random, sets, formats.',
 'server/src/sync/importer.ts': 'CardImporter — streams the gzipped bulk file and upserts oracle_cards, card_printings, card_faces, card_legalities, card_name_variants.',
 'server/src/sync/runSync.ts': 'runSync orchestration: download → import → sets → categories/rulings → price history → price alerts. Reports SyncProgress phases.',
 'server/src/collection/store.ts': 'CollectionStore — locations, lots (add/update/remove/decrement), three-tier browse and card detail, value and snapshots, set completion, cost pools. Every lot change reconciles the decks holding that card.',
 'server/src/porting/backup.ts': 'Backup and restore of the user tables only; the card cache re-downloads.',
 'web/src/App.tsx': 'The shell: topbar, nav, route → view switch, global settings/density/theme, the Browse view, SyncGate and AlertsBell.',
 'web/src/main.tsx': 'Mounts <App/>.',
 'web/src/components/DeckBuilder.tsx': 'Orchestrator for one deck: loads deck, settings, buildability, sheet, runs; owns picker state, undo, and every panel/dialog toggle. Layout is DeckPanes.',
 'web/src/components/DeckPanes.tsx': 'The three-pane layout: deck list (list or lined-up), the picker with chips and art preview, the stats pane, dividers, phone overlays.',
 'web/src/components/DeckList.tsx': 'The decks index: tiles with buildability bars, status and tag filters, sort, duplicate/delete, contention panel, what-if.',
 'web/src/components/DeckRow.tsx': 'One list row: qty ±, name, mana cost, category, the slot chip, art/remove.',
 'web/src/components/DeckTile.tsx': 'One lined-up art tile with the same controls, density-aware.',
 'web/src/components/CollectionPage.tsx': 'Tabs: browse (owned grid + lot detail), add, sets, value, wants, trade lists. Undo for lot edits.',
 'web/src/components/FilterPanel.tsx': 'Structured search filters; exports the Filters type and EMPTY_FILTERS. Hosts PresetBar.',
 'web/src/components/CardDetailPane.tsx': 'Full card: faces, printings, legalities, rulings, prices, who holds it, buy links.',
 'web/src/components/DeckStatsPanel.tsx': 'Size vs format, curve, colours, mana base, template progress, proxied row.',
 'web/src/components/UndoRedo.tsx': 'The undo/redo button pair.',
 'web/src/components/OwnedGrid.tsx': 'Owned-lot tiles with foil overlay and badges.',
 'web/src/components/TradesPage.tsx': 'Trade list and one trade\'s draft editor; complete with conflict handling.',
 'web/src/components/WantListsPage.tsx': 'Want lists with drag reorder, target prices, and substitutes for a want.',
 'web/src/components/GamesPage.tsx': 'Events tab and Record tab; GameRows shared with the deck panel.',
 'web/src/format.ts': 'formatBytes and a zero-safe percent.',
 'web/src/styles.css': 'All CSS in one file. Sections are /* ---------- name ---------- */ headers; grep the feature name.',
 'server/src/routes/alerts.ts': 'The in-app alert inbox: list, count, acknowledge, resolve.',
 'web/src/components/CollectionValuePanel.tsx': 'Collection value, P&L, and a plain-SVG value-over-time sparkline.',
 'schema.sql': 'The complete SQLite schema, loaded verbatim on a fresh database. Every DDL change goes here and in migrations.ts.',
}

def layer_for(p):
    if p == 'schema.sql': return ('data', 'schema')
    if p.startswith('server/'):
        r = p[len('server/src/'):]
        d = r.split('/')[0]
        if r in ('index.ts','config.ts'): return ('entry', 'entry')
        if d == 'routes': return ('routes', 'routes')
        if d == 'db': return ('data', 'db')
        if d in ('sync','images','porting'): return ('services', d)
        if d == 'model': return ('pure', 'model')
        if r in ('decks/allocation.ts','decks/reconcile.ts','decks/buildability.ts','decks/contention.ts','decks/assembly.ts','decks/substitutes.ts','decks/roleHeuristics.ts'): return ('engines', 'decks')
        if d == 'search': return ('engines', 'search')
        if r in ('decks/store.ts','decks/templates.ts','decks/snapshots.ts'): return ('stores','decks')
        if d in ('collection','trades','tradelists','alerts','events','pricing'): return ('stores', d)
        if d == 'decks': return ('pure', 'decks')
        return ('other', d)
    r = p[len('web/src/'):]
    if r in ('main.tsx','App.tsx','router.ts','styles.css','theme.ts'): return ('entry','entry')
    if r == 'api.ts': return ('data','api')
    if r.startswith('components/'):
        n = r.split('/')[1]
        pages = {'CollectionPage','DeckList','DeckBuilder','TradesPage','WantListsPage','TradeListsPage','GamesPage','DataPage'}
        deck = {'DeckPanes','DeckRow','DeckTile','DeckStatsPanel','DeckStatusPill','Buildability','MissingCardsPanel','ShoppingListPanel','ContentionPanel','WhatIfDialog','AssemblyPanel','DeckHistoryPanel','SubstitutesSheet','PlaytestPanel','DeckGamesPanel','DeckArtDialog','DeckExportDialog','DeckImportDialog','CascadePreview','PaneDivider','UndoRedo'}
        base = n.split('.')[0]
        if base in pages: return ('pages','pages')
        if base in deck: return ('deckbuilder','deck builder')
        return ('shared','shared')
    return ('helpers','helpers')

nodes = {}
files = sorted(glob.glob('server/src/**/*.ts', recursive=True) + glob.glob('web/src/**/*.ts', recursive=True) + glob.glob('web/src/**/*.tsx', recursive=True))
files = [f for f in files if not f.endswith('.test.ts') and not f.endswith('.test.tsx') and not f.endswith('setupTests.ts')]
files.append('web/src/styles.css'); files.append('schema.sql')
for f in files:
    lines = sum(1 for _ in open(f))
    blurb = FALLBACK.get(f) or (header_blurb(f) if f.endswith(('.ts','.tsx')) else None) or ''
    layer, group = layer_for(f)
    side = 'web' if f.startswith('web/') else 'server'
    nodes[f] = dict(id=f, side=side, layer=layer, group=group, lines=lines, blurb=blurb, imports=[])
    has_test = os.path.exists(re.sub(r'\.(tsx?)$', r'.test.\1', f))
    nodes[f]['test'] = has_test

for f in files:
    if not f.endswith(('.ts','.tsx')): continue
    src = open(f).read()
    for m in re.finditer(r"from '(\.[^']+)'", src):
        target = os.path.normpath(os.path.join(os.path.dirname(f), m.group(1)))
        if target in nodes and target not in nodes[f]['imports']:
            nodes[f]['imports'].append(target)
# schema.sql ← db/index reads it
nodes['server/src/db/index.ts']['imports'].append('schema.sql')
nodes['server/src/db/migrations.ts']['imports'].append('schema.sql')

TASKS = [
 ("How available / owned / reserved is computed", "server/src/decks/allocation.ts"),
 ("How a deck's claim gets set", "server/src/decks/reconcile.ts"),
 ("Buildable %, missing count, cost to complete", "server/src/decks/buildability.ts"),
 ("Contention alert, reassign, what-if", "server/src/decks/contention.ts"),
 ("Pull sheets and assembly runs", "server/src/decks/assembly.ts"),
 ("Owned substitutes ranking", "server/src/decks/substitutes.ts"),
 ("Deck CRUD and slot edits", "server/src/decks/store.ts"),
 ("Format legality rules", "server/src/decks/validate.ts"),
 ("Collection lots, locations, cost pools", "server/src/collection/store.ts"),
 ("Want lists and fulfilment", "server/src/collection/wants.ts"),
 ("Trade completion (cards in/out)", "server/src/trades/store.ts"),
 ("Scryfall search syntax → SQL", "server/src/search/query.ts"),
 ("owned: / available: / loc: predicates", "server/src/search/collection.ts"),
 ("Bulk sync from Scryfall", "server/src/sync/runSync.ts"),
 ("Add or change a setting", "server/src/routes/settings.ts"),
 ("Which errors become which status", "server/src/routes/errorHandler.ts"),
 ("Any DDL change (with schema.sql)", "server/src/db/migrations.ts"),
 ("The HTTP client and shared types", "web/src/api.ts"),
 ("Top-level views and nav", "web/src/App.tsx"),
 ("URL ↔ view mapping", "web/src/router.ts"),
 ("Deck builder page (data, panels, undo)", "web/src/components/DeckBuilder.tsx"),
 ("Deck builder three-pane layout and picker", "web/src/components/DeckPanes.tsx"),
 ("The 'Have it / Need N' slot chip", "web/src/deckSlot.ts"),
 ("Decks index page", "web/src/components/DeckList.tsx"),
 ("Collection page and its tabs", "web/src/components/CollectionPage.tsx"),
 ("Grouping / sorting card lists", "web/src/deckView.ts"),
 ("Display density", "web/src/density.ts"),
 ("Undo / redo", "web/src/undo.ts"),
 ("All styling", "web/src/styles.css"),
]
out = dict(nodes=list(nodes.values()), tasks=[dict(label=a, id=b) for a,b in TASKS])
html = open(os.path.join(HERE, 'template.html')).read()
assert '/*__DATA__*/' in html
html = html.replace('/*__DATA__*/', json.dumps(out, separators=(',', ':')))
html = html.replace('143 source files · 408 import edges', f"{len(nodes)} source files · {sum(len(n['imports']) for n in nodes.values())} import edges")
html = html.replace('computed from the tree on 2026-09-15', 'computed from the tree on ' + __import__('datetime').date.today().isoformat())
open(os.path.join(HERE, 'codebase-atlas.html'), 'w').write(html)
print(len(nodes), 'nodes', sum(len(n['imports']) for n in nodes.values()), 'edges')
missing=[n['id'] for n in nodes.values() if not n['blurb']]
print('no blurb:', missing)
