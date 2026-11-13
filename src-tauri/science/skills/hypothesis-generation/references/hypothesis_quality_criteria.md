# Human Review Criteria for Candidate Hypotheses

## No automatic quality score

These criteria structure expert review. Do not sum them, assign weights, calculate a “quality score,” rank candidates automatically, or select a winner. Trade-offs and domain assumptions are not commensurable numbers.

For each criterion record:

- evidence or rationale;
- uncertainty and missing information;
- source IDs;
- reviewer role and date;
- revision or test needed.

## Question-level review

### Feasibility

- Are required data, samples, methods, expertise, time, and resources available?
- Is the unit of analysis attainable without pseudoreplication?
- Can the needed precision or information be achieved?
- Are approvals and governance pathways realistically available?
- Would a pilot answer feasibility rather than the scientific hypothesis?

### Interest and relevance

- Which scientific, stakeholder, policy, or practical decision could the answer inform?
- Were affected groups or domain experts involved where appropriate?
- Is the burden of the work proportionate to its expected informational value?

### Novelty

Treat novelty as a separate evidence claim:

- What databases, indexes, registries, patents, repositories, and grey literature were searched?
- What queries, dates, languages, and screening limits were used?
- Was prior work examined for conceptually equivalent terminology?
- Did a domain expert assess near neighbors and historical literature?

Use “not located within the documented search boundary” when that is all the evidence supports. Absence from a quick search is not evidence of novelty.

### Ethics

- Are human, animal, environmental, privacy, community, biosafety, dual-use, and regulatory implications assessed?
- Is there a less burdensome way to answer the question?
- Are harms, benefits, fairness, consent, and stewardship addressed?
- Are required reviews complete before work begins?

FINER—Feasible, Interesting, Novel, Ethical, Relevant—is a mnemonic for refining a question, not a pass/fail instrument. The earliest source located in this refresh is the first edition of *Designing Clinical Research* (Hulley and Cummings, 1988); later editions and current methodological articles present the mnemonic. The dated search did not establish that the 1988 edition was the first printed use, so do not claim coinage without checking the primary text.

## Hypothesis-level review

### Clarity

- Is the statement a candidate proposition rather than an observation or question?
- Are population/system, conditions, variables, direction, and timeframe explicit?
- Is the mechanism separate from the hypothesis statement?
- Are undefined terms and escape clauses removed?

### Testability

- Are observables and measurements available?
- Does the candidate generate at least one prospective prediction?
- Can a feasible design bear on the prediction?
- Are assumptions needed to connect result to candidate stated?

### Falsifiability and vulnerability

- What result would be incompatible under the stated assumptions?
- Could the candidate explain every possible outcome after the fact?
- Are indeterminate outcomes acknowledged?
- Does the proposed test risk only “confirming” the preferred candidate?

A null result can be uninformative because of low precision, failed manipulation, insensitive measurement, missingness, or assumption failure. Record these possibilities before calling a result falsifying.

### Discriminability

- Which rival predicts a different observable pattern?
- Is the difference larger than expected measurement uncertainty?
- Can the test distinguish mixed mechanisms?
- Are positive, procedural, and negative controls informative?
- What result supports neither candidate?

### Mechanistic adequacy

- Does the mechanism specify entities, activities, ordering, and context?
- Does it respect established constraints or explicitly identify where it departs?
- Are intermediate steps measurable?
- Could a simpler bias or measurement explanation produce the observation?

Mechanistic detail is not evidence. A more elaborate story can be less testable.

### Boundary conditions and transport

- Where, when, and for whom should the candidate apply?
- What exposure/intervention versions matter?
- What effect modifiers or contextual dependencies are plausible?
- Which populations, species, platforms, or scales are outside scope?
- What independent replication or external-validation test is planned?

### Assumption transparency

Separate:

- scientific assumptions;
- measurement assumptions;
- design/identification assumptions;
- statistical/model assumptions;
- implementation assumptions.

State which assumptions are testable, partially diagnosable, or fundamentally untestable with available data.

### Evidence alignment

For every source:

- identify the exact claim it bears on;
- distinguish direct from indirect or analogous evidence;
- note design, population/system, and limitations;
- include challenging and null evidence;
- avoid venue prestige, citation count, or author reputation as a substitute for appraisal.

### Uncertainty

- Are direction, magnitude, and interval uncertainty separated?
- Is model or structural uncertainty acknowledged?
- Is measurement uncertainty propagated or discussed?
- Are unknown alternatives and residual confounding visible?
- Are conclusions calibrated to the evidence?

## Prediction-level review

A prediction should identify:

- prediction ID and parent candidate;
- conditions and boundary conditions;
- observable and measurement ID;
- expected pattern, direction, magnitude/range if justified, and timing;
- rival and rival-expected pattern;
- falsifier/incompatible result;
- indeterminate outcome;
- linked analysis ID;
- assumptions and uncertainty.

Do not invent numerical effect sizes merely to appear specific. If magnitude is unknown, prespecify the direction, smallest effect of scientific interest, precision target, or a range of plausible values with rationale.

## Operationalization review

For each construct ask:

- Does the variable actually represent the construct?
- Is the instrument validated in the target context?
- Are reliability, calibration, detection limits, and quality control addressed?
- Are timing and aggregation aligned with the mechanism?
- Are cut points prespecified and justified?
- Are missingness and measurement error mechanisms considered?
- Is comparability across groups, time, sites, species, or devices established?
- Could the measurement itself be affected by exposure, outcome, or selection?

## Causal-claim review

Require:

- a well-defined intervention/exposure contrast;
- causal estimand;
- target population and horizon;
- design/target-trial analogue;
- identification assumptions;
- confounding, selection, collider, measurement, and reverse-causation assessment;
- positivity/overlap and interference considerations where applicable;
- sensitivity analyses and negative controls where scientifically defensible.

Predictive performance does not identify a causal effect. Adjustment does not guarantee exchangeability. Conditioning on a mediator or collider can introduce bias.

## Analysis-plan review

Check:

- unit and dependence structure;
- sample-size/precision rationale;
- exclusions and stopping;
- outcome and analysis populations;
- transformations and model specification;
- effect/summary measures and uncertainty;
- missing data and intercurrent events;
- multiplicity across hypotheses, outcomes, subgroups, models, and looks;
- assumptions and diagnostics;
- robustness and sensitivity analyses;
- confirmatory/exploratory labels;
- deviation-reporting process.

## Decision record

End human review with one of:

- `revise_before_test`;
- `ready_for_preregistration_review`;
- `blocked_by_safety_or_ethics_gate`;
- `blocked_by_measurement_or_feasibility`;
- `retain_as_exploratory_candidate`;
- `requires_specialist_review`.

These are workflow states, not scientific truth judgments and not outputs of a score.
