# Common Issues in Manuscript Review

Use this reference as a prompt for inquiry, not a defect checklist. A possible issue becomes a review comment only when it is relevant to the study and supported by a manuscript location, supplied artifact, or applicable method principle.

Do not infer misconduct, poor quality, or manuscript merit from a missing reporting item. Separate:

- **Not reported:** the manuscript does not provide enough information to assess the point.
- **Potential design or analysis problem:** the reported method may not answer the stated question.
- **Demonstrated inconsistency:** two supplied artifacts or manuscript locations conflict.
- **Integrity concern:** credible evidence should be described neutrally and routed through the journal process, normally in confidential editor notes.

## Claim–evidence alignment

Check each central claim against the design, analysis, result, and uncertainty that support it.

Common mismatches:

- Causal wording from an observational or otherwise non-identifying design
- Mechanistic conclusions supported only by association or prediction
- Conclusions based on a secondary, exploratory, or post hoc outcome without labeling
- Directionally correct claims that overstate magnitude or precision
- Population, setting, intervention, comparator, outcome, or time-horizon extrapolation
- “No effect,” “equivalent,” or “safe” conclusions from imprecise or non-significant results
- Abstract or conclusion claims that omit material harms, uncertainty, subgroup caveats, or null findings
- Novelty claims that are broader than the search or cited literature supports

Constructive response:

1. Identify the claim and its location.
2. Identify the relevant result or missing evidence.
3. Explain the alignment problem.
4. Request a bounded remedy: narrow wording, add uncertainty, clarify exploratory status, provide the prespecified analysis, or justify the inference.

Use `scripts/validate_claim_evidence.py` for a local identifier-based matrix. Its report never echoes claim text.

## Study question, design, and units

### Question–design mismatch

Check whether the population, intervention or exposure, comparator, outcomes, timing, and target quantity align from objectives through interpretation. For trials, identify the estimand when relevant. For prediction, distinguish model development from performance evaluation. For diagnostic studies, distinguish diagnostic accuracy from clinical utility.

### Experimental or observational unit

Potential issues include:

- Technical replicates treated as independent biological units
- Multiple cells, images, lesions, eyes, visits, or samples per subject analyzed as independent
- Cluster assignment analyzed at the individual level without accounting for clustering
- Paired or repeated observations analyzed as unpaired
- Site, operator, batch, family, spatial, or temporal dependence ignored

Request a clear definition of the unit, nesting, repeated measures, and analysis that reflects dependence. Do not assume a mixed model is always the correct remedy; the model must match the design and question.

### Selection, allocation, and masking

Assess, as applicable:

- Sampling frame, recruitment, eligibility, and exclusions
- Sequence generation and allocation concealment
- Prospective stopping rules
- Blinding or masking of participants, personnel, outcome assessors, and analysts
- Consequences and mitigation when masking is infeasible
- Baseline measurement timing and post-allocation exclusions

Avoid treating baseline significance tests as proof of successful randomization. Focus on chance imbalance, clinically important imbalance, prespecified adjustment, and departures from the randomized comparison.

### Confounding and causal identification

For causal claims, ask:

- What target causal contrast is intended?
- Which assumptions connect the design and analysis to that contrast?
- Were confounders selected using subject-matter reasoning rather than outcome-driven screening?
- Could adjustment introduce collider or mediator bias?
- Are time-varying treatment, censoring, immortal time, or informative observation processes relevant?
- Are negative controls, sensitivity analyses, or alternative explanations appropriate?

Do not demand a specific causal method without showing why it fits the data-generating process.

## Sample size, precision, and replication

Avoid fixed heuristics such as “n < 30 is too small” or “three replicates are sufficient.” Adequacy depends on the target effect or precision, variability, design effect, event count, model complexity, multiplicity, attrition, and decision context.

Check:

- Prospective rationale for sample size or precision
- Inputs, assumptions, software or method, and allowance for attrition or clustering
- Whether the primary outcome and analysis match the calculation
- Event and outcome information relative to model complexity
- Effective sample size after dependence, missingness, weighting, or splitting
- Independent biological replication and validation where the claim requires it
- Precision of estimates, not only nominal power

Observed or post hoc power calculated from the observed effect generally adds little beyond the estimate and its interval. Request effect estimates and uncertainty rather than “achieved power.”

## Statistical analysis

### Analysis–design alignment

Check whether the analysis respects:

- Outcome scale and distribution
- Pairing, clustering, repeated measures, censoring, and competing events
- Sampling design, weights, matching, stratification, or blocking
- Outcome hierarchy and prespecified estimand
- Non-inferiority or equivalence margins and analysis populations
- Longitudinal timing and informative dropout

Do not prescribe “parametric” or “non-parametric” methods from sample size alone.

### Assumptions and diagnostics

The relevant assumptions depend on the estimand and model. A standalone normality test is not a universal gatekeeper and can be uninformative in very small or large samples. Look for design-aware diagnostics, residual behavior, influential observations, functional form, calibration, proportional hazards where applicable, and sensitivity to reasonable alternatives.

Comments should identify the assumption at risk and why it matters. “Check normality” without specifying the modeled quantity or consequence is not actionable.

### Effect estimates and uncertainty

Flag:

- Thresholded interpretation of p-values
- P-values used as effect size, importance, or probability that a hypothesis is true
- “Significant” versus “not significant” used as evidence of a difference between effects
- Missing effect estimates, compatible intervals, denominators, or units
- Excessive precision or inconsistent rounding
- Confidence, credible, or prediction intervals described incorrectly
- Clinical or practical importance conflated with statistical compatibility

Prefer estimates, uncertainty, assumptions, and context. The ASA p-value principles and SAMPL reporting guidance are indexed in `assets/source_ledger.csv`.

### Multiplicity and analysis flexibility

Assess:

- Number and hierarchy of outcomes, time points, subgroups, contrasts, and models
- Interim looks, adaptive changes, or repeated data inspection
- Family or false-discovery control when required by the inferential aim
- Transparent labeling of confirmatory and exploratory analyses
- Consistency with protocol, registration, and statistical analysis plan
- Complete reporting rather than selective presentation of favorable analyses

Not every collection of analyses requires the same correction. Ask authors to state the inferential family and rationale instead of automatically demanding Bonferroni adjustment.

### Missing data and intercurrent events

Check:

- Amount and reasons by group and time
- Distinction between intercurrent events and missing observations when relevant
- Assumptions behind complete-case, imputation, weighting, likelihood, or other methods
- Inclusion of variables and uncertainty in multiple imputation
- Sensitivity analyses to plausible departures from assumptions
- Alignment between the target quantity, data collection, and missing-data strategy

Do not require a test that data are “missing completely at random”; missingness assumptions are not generally established by a single diagnostic test.

### Outliers, transformations, and limits

Check whether exclusions, transformations, winsorization, detection-limit handling, and influential-observation rules were prespecified or transparently justified. Request sensitivity analyses when conclusions depend materially on discretionary handling. Do not demand deletion merely because a value is extreme.

### Subgroups and heterogeneity

Look for prespecification, adequate interaction analysis, multiplicity, uncertainty, biological or clinical rationale, and consistency of direction. Within-group significance and between-group non-significance do not establish subgroup differences.

### Prediction and machine learning

Check:

- Clear target population, outcome, prediction time, and intended use
- Separation of training, tuning, and evaluation without leakage
- Representative evaluation data and transportability
- Handling of missing values and preprocessing within resampling folds
- Calibration as well as discrimination when relevant
- Uncertainty around performance and decision consequences
- Overfitting, optimism correction, and external evaluation
- Model and preprocessing availability, versioning, and human oversight
- Fairness analyses tied to intended use, not demographic metrics without context

TRIPOD+AI applies to regression and machine-learning prediction models; STARD-AI applies when diagnostic accuracy is the primary evaluation target.

## Reproducibility and transparency

Check whether another qualified researcher could understand and, where permissions allow, repeat the work:

- Protocol, registration, amendments, and analysis plan
- Data provenance, processing stages, exclusions, and versioned identifiers
- Reagents, materials, instruments, software, package versions, parameters, and seeds
- Code, environment or lock file, run order, and computational resources
- Data, code, model, and material availability statements
- Repository accession numbers and persistent identifiers
- Clear, justified restrictions for privacy, consent, security, licensing, or community governance

“Available on request” is not automatically invalid, and open release is not always ethical or lawful. Evaluate whether the access route is specific, feasible, and consistent with governance.

Do not claim to have reproduced an analysis unless it was actually run with documented inputs, environment, commands, and outputs.

## Figures, tables, and images

Assess the supplied artifact directly; do not infer manipulation from low-resolution rendering alone.

Check:

- Axes, units, denominators, scales, legends, and uncertainty definitions
- Individual data or distribution display when summary graphics conceal relevant structure
- Accessibility and redundant encoding beyond color alone
- Consistency among text, tables, figures, and supplements
- Sample sizes and exclusions for each panel or analysis
- Image acquisition, processing, normalization, scale bars, and representative-image selection
- Disclosed splicing or adjustments and availability of source images when policy requires
- Avoidance of deceptive truncation, area/volume encoding, or dual-axis implication

Possible duplication or manipulation should be documented neutrally by location and referred to the editor under the journal’s image-integrity process. Do not accuse authors of fabrication.

## Ethics, welfare, privacy, and integrity

Check what is applicable:

- Ethics committee or institutional review and identifiers
- Consent, assent, waiver, or lawful basis
- Trial registration and prospective protocol availability
- Animal welfare, humane endpoints, and relevant ARRIVE items
- Privacy, identifiability, community governance, and controlled access
- Funding, sponsor role, author conflicts, and contributor roles
- Dual-use, biosafety, environmental, or security considerations
- Prior publication, overlapping reports, and transparent secondary analyses

If a concern cannot safely be raised with authors, use the confidential editor channel. State the evidence and uncertainty; do not investigate people, contact institutions, or reveal the manuscript outside the authorized process.

## Citations and references

Check:

- Every consequential literature claim has an appropriate source
- The cited source supports the stated proposition
- Primary sources are used for methods, data, and policies when available
- Retracted or corrected work is handled appropriately
- Contradictory and relevant evidence is represented fairly
- Self-citation requests are necessary, specific, and not coercive
- Citation identifiers and reference entries are internally consistent

The local `scripts/audit_citations.py` checks Pandoc-style keys such as `[@ref-id]` against a CSV. It does not verify source existence or support and must not be described as doing so.

## Writing actionable comments

For each major or minor comment, include:

- **Location**
- **Observation**
- **Evidence or criterion**
- **Why it matters**
- **Requested action**

Prefer: “At Methods, paragraph 3, the experimental unit is unclear. Because three measurements appear to come from each participant, please define the unit and explain how within-participant dependence was handled.”

Avoid: “The statistics are bad.”

Requests for new experiments should be necessary to support an existing central claim, ethically and practically proportionate, and distinguished from optional future work. Often the appropriate remedy is to narrow a claim, add a limitation, provide missing analysis detail, or share an existing artifact.
