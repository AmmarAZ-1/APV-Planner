# APV-Planner

A browser tool for planning router and access point (AP) placement in a house. You trace each floor over a plan image, draw it, or type it in. Then you tag wall materials, place the ONT, and get a recommended AP count and layout with a live, multi-floor coverage heatmap.

No build step and no dependencies: plain ES modules and a Web Worker.

## Run it

```bash
python -m http.server 8000
```

Then open <http://localhost:8000>. It needs to be served over HTTP (not `file://`) because of ES modules and the worker. Any static server works, including GitHub Pages.

To try it quickly, pick **Samples… → Sample 2-storey house (traced)**, or **…plan images only** to practise tracing.

## Workflow

### 1. Plan (Stage 1: floor plan editor)
- **Floors** (left panel): add floors bottom to top. Each has a label and a storey height (default 2.7 m); a floor's plane sits at the sum of the heights below it.
- **Upload a plan image** per floor, then use the **Scale** tool: click two points a known distance apart and enter the meters. From then on, all geometry is stored in meters.
- **Wall** (W): click corners; Shift locks to 45°; double-click, Enter or right-click ends the run. Snaps to corners and walls.
  **Room** (R): drag a rectangle. **Opening** (O): click two points on a wall to cut a door or window into it.
- **Materials:** drywall 3.5 dB, wood door 4, brick 8, reinforced concrete 18, glass 3, other (per-wall value). Defaults are editable.
- **Align** (A): click the same physical point on every floor so floors traced from differently cropped images stack correctly. The floor below is shown dashed for reference.
- **ONT** (N): click to place.
- No image? Draw on the metric grid, or add walls and rooms by typing coordinates (right panel).
- **Model JSON** shows the exact serialisable model. **Save** downloads it with the images embedded, and **Open…** loads it back. Work also autosaves in the browser (IndexedDB).

### 2. Coverage (Stage 2: single-AP coverage)
Place an AP (P) on any floor and drag it: the heatmap updates live. The floor selector switches which floor's heatmap you see; the AP still contributes to every floor. Hover over the plan to see RSSI with its breakdown (distance, walls, floors). All model parameters are adjustable.

### 3. Plan APs (Stages 3 and 4)
- **Step 1 – how many APs:** total indoor area ÷ the best single-AP coverage found at probe positions gives `⌈0.95 × area / A₁⌉`. You can accept the estimate, override it, or let the optimizer decide.
- **Step 2 – optimize:** greedy incremental placement. Each AP goes where it adds the most still-uncovered area. It stops at the target coverage, when the next AP would add fewer than 3 pp, or at the maximum AP count.
  - **Backhaul:** *wired to ONT* (any position) or *wireless mesh* (each added AP needs a link of at least −65 dBm to an existing AP; if none is possible, it is flagged).
  - The readout lists each AP's floor, position and marginal gain, so you can see why it stopped.

## Physics

```
PL(d) = PL0 + 10·n·log10(d/d0) + Σ wall dB (per storey the path passes through) + floors crossed × slab dB
RSSI  = TxPower − PL(d)
```

Defaults: PL0 = 40 dB at d0 = 1 m (2.4 GHz free space), n = 3, slab = 15 dB, Tx = 20 dBm, AP 2.0 m and client 1.0 m above their floors, 0.5 m grid, threshold −67 dBm. Sources, value ranges and the model's limits are in [docs/LITERATURE.md](docs/LITERATURE.md).

## Code

| File | Role |
|---|---|
| `src/model.js` | Project data model, model-JSON export/import |
| `src/editor.js` | Canvas editor: view, tools, snapping |
| `src/propagation.js` | Path loss, indoor-area flood fill, coverage grid (pure, no DOM) |
| `src/coverage.js` | Heatmap layer, AP markers, Coverage panel |
| `src/estimate.js` | Stage 3 AP-count estimate |
| `src/optimizer.js`, `src/optimizer.worker.js` | Stage 4 greedy placement (runs in a worker) |
| `src/planner.js` | Plan APs panel |
| `tests/` | `node --test` unit tests for geometry, physics, estimate and optimizer |

```bash
npm test
```

## License

GPL-3.0; see [LICENSE](LICENSE).
