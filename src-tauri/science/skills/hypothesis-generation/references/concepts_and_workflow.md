# Concepts and Candidate Lifecycle

## Purpose

This reference prevents common category errors in hypothesis work. It is a vocabulary and workflow guide, not a theory of confirmation and not an automatic ranking method.

## Object model

### Observation

A bounded account of what was detected or reported:

- source or measurement;
- population/system, place, and time;
- unit of observation;
- preprocessing, exclusions, missingness, and uncertainty;
- whether the observation was expected or selected after inspection.

An observation can be mistaken, biased, or unrepresentative. It does not explain itself.

### Research question

An answerable question that fixes the scope of inquiry. It should identify the target population/system, variables or interventions, comparator where meaningful, outcome, timeframe, context, and claim type.

PICO/PICOT is appropriate for many intervention-effect questions. It is not a universal ontology. Use a framework matched to the question and involve affected stakeholders where appropriate.

### Hypothesis

A candidate proposition that could explain or relate observations and yield testable implications. Keep its status as `candidate` until evidence changes the state. Avoid “validated hypothesis,” “proven mechanism,” and similar language unless the statement is being used only to quote a source accurately.

### Mechanism

A proposed process connecting antecedent conditions to an outcome. A mechanism should identify entities, activities, ordering, and boundary conditions where the domain permits. A plausible narrative without discriminating predictions remains a story.

### Causal estimand

A precise target causal contrast. At minimum, state:

- target population/system;
- intervention/exposure and comparator;
- outcome and time horizon;
- population-level summary;
- treatment versions and intercurrent-event strategy where relevant;
- identification assumptions.

The estimand is the target, the estimator is the method, and the estimate is the numerical result.

### Prediction

An observable implication derived from a candidate before checking the target result. A useful prediction specifies conditions, measurement, expected pattern, uncertainty, and an incompatible result. It should distinguish at least one rival when possible.

### Alternative explanation

A rival account that could produce the same observation. Rivals include:

- distinct mechanisms;
- measurement or processing artifacts;
- confounding/common causes;
- selection or attrition;
- collider conditioning;
- reverse causation;
- contextual or temporal heterogeneity;
- stochastic variation.

Rivals can coexist. Do not force mutual exclusivity when a mixed explanation is scientifically plausible.

### Null hypothesis

A defined no-effect/no-difference model used in an analysis. It is not “nothing happened,” and failure to reject it does not establish equivalence or absence. Define compatibility, equivalence, or non-inferiority rules separately when those are the scientific targets.

### Negative control

A control in which the target mechanism should not operate but relevant bias pathways should remain. Negative exposure and negative outcome controls can reveal confounding, selection, measurement, or analytic bias when their assumptions are credible. A negative control does not repair bias automatically.

### Operationalization

The mapping from a construct to a measurement, category, intervention, or variable. Record instrument/method, unit, timing, population/system, validity, reliability, calibration, missingness, transformations, cut points, and limitations.

### Analysis plan

The planned mapping from data to estimand, prediction, or descriptive target. It includes units, populations, transformations, models, contrasts, effect measures, uncertainty, missingness, multiplicity, diagnostics, sensitivity analyses, and decision rules.

### Evidence

Empirical observations or documented sources that bear on claims. Record whether a source supports, challenges, contextualizes, or supplies a method. Citation presence does not prove claim support; a human must inspect the source.

## Candidate lifecycle

Use explicit states:

1. **Draft candidate** — generated but not yet searched or operationalized.
2. **Evidence-bounded candidate** — linked to a dated search and source ledger.
3. **Test-ready candidate** — has measurements, rivals, falsifiers, controls, and analysis links.
4. **Preregistered candidate** — time-stamped before the relevant outcome was inspected.
5. **Tested candidate** — results and deviations are available.
6. **Retained, revised, challenged, or unresolved** — human interpretation with uncertainty.

Never use `true`, `proven`, or `selected_winner` as a machine-generated state.

## Multiple hypotheses and strong inference

Platt’s 1964 strong-inference essay advocates:

1. devising alternative hypotheses;
2. devising a crucial experiment with alternative possible outcomes that exclude candidates;
3. performing the experiment cleanly;
4. recycling the process with subhypotheses.

Use this as a discipline for contrast, not as a guarantee of truth. In practice:

- alternatives may be incomplete;
- candidates may not be mutually exclusive;
- auxiliary assumptions can fail;
- measurements may not distinguish the intended mechanisms;
- a “crucial” result may be indeterminate;
- exclusions remain provisional.

Always include an “unknown or mixed explanation” path in interpretation.

## Exploratory and confirmatory modes

### Exploratory

- Generates observations, candidates, variables, and models.
- Can be data-dependent.
- Must record that dependence.
- Produces hypotheses for future tests rather than relabeling the same-data analysis as confirmation.

### Confirmatory

- Defines hypotheses, outcomes, exclusions, transformations, models, and decision rules before inspecting the target result.
- Preserves the planned analysis.
- Reports deviations and additional analyses transparently.

Both modes are scientifically valuable. The integrity failure is not exploration; it is presenting exploration as if it were prespecified.

## Uncertainty vocabulary

Prefer:

- “candidate explanation”;
- “consistent with under the stated assumptions”;
- “challenges this candidate if measurement and design assumptions hold”;
- “not distinguished by this result”;
- “not located within the documented search boundary”;
- “requires replication or external validation.”

Avoid:

- “proved” or “disproved” for ordinary empirical results;
- “novel” based only on no quick search hit;
- “no effect” from a non-significant result;
- “causes” from an unqualified association;
- “the mechanism” when several remain plausible.

## Minimum handoff

A hypothesis package should contain:

- frozen observation;
- framed question and claim type;
- dated search boundary and source ledger;
- candidate hypotheses and mechanisms;
- rivals and bias explanations;
- causal estimand if applicable;
- discriminating predictions and falsifiers;
- operationalization and measurement-validity record;
- nulls and controls;
- design and analysis plan;
- uncertainty and boundary conditions;
- ethics/safety/regulatory gates;
- preregistration/deviation plan;
- accountable human review.
