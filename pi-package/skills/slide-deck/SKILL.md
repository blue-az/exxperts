---
name: slide-deck
displayName: Slide Deck
description: Executive slide deck outlines and HTML-ready slide content
---

Use this skill when the user asks for a slide deck, presentation, storyline, deck outline, slide-by-slide content, or HTML-ready slide content.

This is a **deck-craft** skill: it owns storyline, scaffolds, output formats, and the quality bar. The Content Producer agent owns the brief gate, the tool protocol (workbench create → attach → preview/render → save), approval-gating, and every safety/fidelity caveat — follow the agent for all of that. In particular, this skill never claims a file was created unless an approved artifact-write tool result confirms it, and never claims PPTX/PDF export or exact fidelity.

Output plain Markdown for outlines and unsaved drafts; do not wrap the whole response in a code fence. Before drafting or saving a substantial deck, the agent's brief gate applies (infer the brief; ask only what materially matters; don't spend tokens on the full deck or call write tools until the brief is sufficiently complete or defaults are requested). Do not make a Markdown outline the default for "make/create slides" asks — those default to a transient Deck Workbench draft per the agent.

## Quality bar

Produce an executive-quality storyline, not a generic bullet dump. A strong deck has:

1. A clear audience and goal
2. A narrative arc: context → tension/problem → insight/solution → proof/architecture → decision/next step
3. One main message per slide
4. Concise, slide-sized content
5. A practical recommendation or ask

Keep speaker notes only when useful.

Avoid:

- Long paragraphs on slides
- Repeating the same message across slides
- Empty buzzwords such as "innovative", "seamless", or "future-proof" without proof
- Overclaiming facts not provided or sourced
- Full HTML unless the user explicitly asks for it

## 5-slide executive default

For **5-slide executive/internal/product review decks**, prefer this decision-first scaffold unless the user asks otherwise:

1. Decision context / tension — what decision is needed now, why current state is insufficient, risk/opportunity at stake.
2. Evidence snapshot — source-backed facts that matter for the decision.
3. Options / trade-offs — 2–3 plausible paths with consequences.
4. Recommendation — clear recommended path and why.
5. Decision ask + next 30 days — concrete ask, owner/action, immediate next steps.

Storyline rules for this deck type:

- Avoid pure "what is" recap decks.
- Put recommendation/decision pressure early.
- Make slide titles action-oriented "so what" statements where possible.
- Vary slide roles (context, evidence, trade-off, recommendation, ask) instead of repeating one slide shape.
- Preserve provenance and do not invent unsupported facts.

## Deck outline format

For deck outlines, use this format by default:

```md
## Assumptions
- Audience: ...
- Goal: ...
- Style: ...

## Storyline
One short paragraph or 3–5 beats.

## Slide outline

### Slide 1 — <title>
**Key message:** <one sentence>
- <bullet 1>
- <bullet 2>
- <bullet 3>
**Visual idea:** <optional>

### Slide 2 — <title>
...

## Recommended next step
<one concrete next action>
```

Each slide should include: slide number, title, key message, 3–5 concise bullets, optional visual idea.

## HTML-ready slide content format

When the user asks for HTML-ready content, output structured Markdown suitable for later HTML conversion. Keep content slide-sized and avoid raw HTML unless explicitly requested.

```md
## Deck metadata
- Audience: ...
- Goal: ...
- Style: ...

---

# Slide 1: <title>

**Key message:** <one sentence>

- <short bullet>
- <short bullet>
- <short bullet>

**Speaker note:** <optional, 1–2 sentences>
**Visual idea:** <optional>

---

# Slide 2: <title>
...
```

Do not include CSS, scripts, full HTML documents, or file paths unless the user explicitly asks for implementation-ready HTML or to save an approved local HTML artifact.

## Saved-deck filename

When saving, derive a short, meaningful, safe lowercase kebab-case filename from the deck title/topic, ending in `.html`. Avoid generic names like `deck.html` unless no usable topic/title exists. Preserve explicit user filenames when already safe. (The save tools, approval-gating, and fidelity caveats are the agent's.)

## Style handling

Default to content-only. Mention simple visual direction only when useful:

- stark black/white contrast
- bold, minimal titles
- low text density
- strong section dividers
- simple diagrams instead of decorative imagery
- clear CSS fallback fonts if HTML references Bandeins/Sen

Be honest about what the artifact can render — see the agent's typography-honesty caveat (no Bandeins/Sen fidelity unless fonts are actually available; use "exxperts-inspired … only if installed/available" wording; no external network font loading).

## Sales/business decks

For executive sales or investment decks, emphasise:

- Business problem and urgency
- Value proposition
- Evidence / proof points / product maturity
- Delivery approach
- Risks and mitigations
- Decision ask and next step

## Technical architecture decks

For technical decks, emphasise:

- Current state / constraints
- Target architecture and principles
- Key components and responsibilities
- Data/control/security flows
- Governance, operations, and risk controls
- Phased implementation path

Keep technical slides understandable for mixed business/technology audiences unless the user asks for deep technical detail.

## Footer when useful

For larger or ambiguous deck requests, end with:

- **Assumptions:** short bullets
- **Open questions:** short bullets, or `none`
- **Recommended next step:** one line
