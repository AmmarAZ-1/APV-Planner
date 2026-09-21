# Physics and algorithms: literature notes

This note records where APV Planner's model, defaults and optimizer come from, and what they leave out.

## 1. Indoor propagation: the multi-wall-and-floor model

APV Planner uses the empirical **multi-wall** family of indoor models, which started with Motley and Keenan and was later standardised in COST 231:

```
PL(d) = PL0 + 10·n·log10(d/d0) + Σ Lwall_i + k_f · L_floor
RSSI  = P_tx − PL(d)
```

| Term | Meaning | Default | Source / rationale |
|---|---|---|---|
| `PL0` at `d0 = 1 m` | Reference loss at 1 m | 40 dB (2.4 GHz) | Free-space loss `20·log10(4π·d0·f/c)`: 40.0 dB at 2.4 GHz, 46.4 dB at 5.2 GHz, 47.9 dB at 6 GHz. The *Band* selector sets these. |
| `n` | Distance power-loss exponent | 3.0 | Measured indoor exponents run from about 1.6 in corridors (guiding effect) up to 3–4 through cluttered, multi-wall paths (Rappaport, *Wireless Communications*, Table 4.6). The multi-wall term already counts walls explicitly, so `n ≈ 2–3` is the usual choice there. 3 is a conservative middle value. |
| `Lwall` | Per-wall penetration loss | By material, see §2 | Motley & Keenan (1988); COST 231 Final Report §4.7 (1999) |
| `L_floor` | Per-slab loss | 15 dB | Seidel & Rappaport (1992) measured about 13 dB for one floor. ITU-R P.1238 lists 5 dB (houses) and 10 dB (apartments) at 2.4 GHz for wooden/light floors, and 15+ dB for concrete office floors. |

**How walls are counted across floors.** The horizontal projection of the 3D path T→R is split into pieces, one per storey the path passes through. On each storey, only that piece is tested against that floor's walls. A steep path between floors therefore crosses only the walls it actually passes. Floor crossings are counted by comparing the floor indices of T and R.

**Wall intersection.** A standard parametric segment–segment test is used. The path parameter is open, so an endpoint lying on a wall does not count. The wall parameter is half-open, so a path through the shared corner of two chained walls counts once. Collinear grazing does not count.

**Known simplifications** (shared by the whole empirical multi-wall family):
- Wall loss does not depend on angle of incidence. Oblique paths really see a thicker wall.
- There is no reflection, diffraction or waveguiding, so corridors and door gaps are underestimated.
- Floor loss is linear in the number of slabs. COST 231 uses a sub-linear exponent, `k_f^((k_f+2)/(k_f+1) − b)`, and Seidel & Rappaport observed the extra loss per floor shrinking after 3–4 floors. For houses (≤ 3–4 floors) the linear form is within a few dB.
- Material values are 2.4 GHz values. At 5–6 GHz most materials attenuate 1.5–2× more in dB, so raise them when planning 5/6 GHz.
- Only the downlink (AP→client) is modelled. Real clients transmit at 12–15 dBm, below a typical AP's 20 dBm, so the uplink is often the real limit at the cell edge. Matching AP power to clients, or planning to a stricter threshold, compensates for this.

## 2. Wall material defaults (dB per wall crossed, 2.4 GHz)

| Material | Default | Reported range | Notes |
|---|---|---|---|
| Drywall / gypsum partition | 3.5 | 2–5 | Single sheet about 2–4 dB; stud wall with two sheets about 3–5 dB |
| Wood door | 4 | 2–6 | Hollow-core at the low end, solid at the high end |
| Brick | 8 | 6–12 | Single leaf about 6 dB; cavity or double wall 10+ dB |
| Reinforced concrete | 18 | 15–25+ | Rebar density dominates. Thick structural walls can exceed 30 dB |
| Glass (clear window) | 3 | 2–4 | Low-E or metal-coated glazing can reach 20–40 dB: use "Other" |
| Other | 6 (editable per wall) | — | Metal doors ~6–12 dB; elevator/utility shafts 20–30 dB |

Sources: NIST IR 6055 (Stone, 1997), which measured attenuation of common construction materials; Wilson, *Propagation Losses Through Common Building Materials, 2.4 GHz vs 5 GHz* (Magis Networks, 2002); vendor design guides (Cisco, Ekahau, iBwave) that tabulate the same ranges.

## 3. Coverage target

-67 dBm is the widely used design RSSI for voice/video-grade Wi-Fi (Cisco and Apple enterprise design guides). It keeps SNR above roughly 25 dB at a typical -92 dBm noise floor. A "95% of floor area" target leaves room for corners and closets that don't matter.

## 4. AP count estimate (Stage 3)

`N₀ = ⌈ target_fraction × total_area / A₁ ⌉`, where `A₁` is the largest area one AP covers in *this* house. A₁ comes from the full model, run at each floor's indoor centroid and its four quadrant centroids. Because A₁ accounts for the house's walls and slabs, it is more honest than a free-space coverage radius. The ratio assumes APs don't overlap, so N₀ is a **lower bound**. The greedy stage then revises it, usually upward.

## 5. AP placement (Stage 4)

Placing N APs to maximise covered area is a **maximum-coverage problem**, which is NP-hard. The coverage function *f(S)* is the number of cells at or above the threshold given AP set *S*. It is monotone (adding an AP never removes coverage) and **submodular** (an AP's marginal gain can only shrink as others are added). For such functions the greedy rule, "add the AP with the largest marginal gain", is guaranteed to reach at least `(1 − 1/e) ≈ 63%` of the optimum. No polynomial-time algorithm can do better unless P = NP. See Nemhauser, Wolsey & Fisher (1978) and Feige (1998).

The WLAN-planning literature follows the same pattern: greedy or greedy-plus-local-search heuristics over a discretised candidate set, scored with a multi-wall propagation model. Examples include Kouhbor et al. (2005), Bosio, Capone & Cesana (2007), and the greedy vs. simulated-annealing comparison in *Layout optimization of wireless access point placement using greedy and simulated annealing algorithms*. Mesh backhaul constraints are usually modelled as a minimum AP↔AP link budget. APV Planner uses -65 dBm by default, a common rule of thumb for a 5 GHz backhaul that still carries high MCS rates.

Stopping rules follow directly from submodularity. Gains shrink monotonically, so once the next AP adds less than the minimum gain (default 3 percentage points), no later AP will add more.

## References

- J. M. Keenan and A. J. Motley, "Radio coverage in buildings," *British Telecom Technology Journal*, 8(1), 1990; A. J. Motley and J. M. Keenan, "Personal communication radio coverage in buildings at 900 MHz and 1700 MHz," *Electronics Letters*, 24(12), 1988.
- COST Action 231, *Digital mobile radio towards future generation systems*, Final Report, European Commission, 1999, §4.7 (indoor multi-wall model).
- S. Y. Seidel and T. S. Rappaport, "914 MHz path loss prediction models for indoor wireless communications in multifloored buildings," *IEEE Trans. Antennas Propag.*, 40(2), 1992.
- ITU-R Recommendation P.1238, *Propagation data and prediction methods for the planning of indoor radiocommunication systems* (e.g. P.1238-11, 2021). https://www.itu.int/rec/R-REC-P.1238
- T. S. Rappaport, *Wireless Communications: Principles and Practice*, 2nd ed., Prentice Hall, 2002, ch. 4.
- W. C. Stone, *Electromagnetic Signal Attenuation in Construction Materials*, NIST IR 6055, 1997.
- R. Wilson, *Propagation Losses Through Common Building Materials: 2.4 GHz vs 5 GHz*, Magis Networks, 2002.
- G. L. Nemhauser, L. A. Wolsey and M. L. Fisher, "An analysis of approximations for maximizing submodular set functions," *Mathematical Programming*, 14, 1978.
- U. Feige, "A threshold of ln n for approximating set cover," *J. ACM*, 45(4), 1998.
- S. Bosio, A. Capone and M. Cesana, "Radio planning of wireless local area networks," *IEEE/ACM Trans. Networking*, 15(6), 2007.
- Y. Kouhbor, A. Stranieri, et al., "Optimal placement of access point in WLAN based on a new algorithm," *ICMB*, 2005.
- iBwave, "Exploring attenuation across materials, 2.4 GHz / 5 GHz," https://blog.ibwave.com/a-closer-look-at-attenuation-across-materials-the-2-4ghz-5ghz-bands/
