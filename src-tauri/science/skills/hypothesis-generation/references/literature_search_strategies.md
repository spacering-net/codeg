# Evidence Search and Source Traceability

## Scope

This workflow supports hypothesis formulation. It is not automatically a systematic review, evidence-grade, patentability search, regulatory determination, or proof of novelty.

## Data and confidentiality gate

Before searching:

- remove confidential identifiers, unpublished results, proprietary sequences, exact vulnerabilities, and controlled operational details from queries;
- confirm that external search is authorized;
- translate sensitive observations into the minimum non-sensitive concepts needed;
- use approved local or institutional search tools when policy requires;
- record what was withheld and how that limits the search.

Do not send unpublished or sensitive data to an external search engine, AI service, citation service, or model without explicit authorization.

## Frame the search

Separate search objectives:

1. **Phenomenon:** Has the observation or a close analogue been reported?
2. **Mechanism:** Which processes could explain it?
3. **Rivals:** Which alternative mechanisms, artifacts, or biases are documented?
4. **Measurement:** How have the constructs been operationalized and validated?
5. **Design:** Which tests discriminate the candidates?
6. **Contrary evidence:** What findings challenge each candidate?
7. **Safety and governance:** Which ethical, biosafety, dual-use, data, or regulatory rules apply?
8. **Priority/novelty:** What prior work, registrations, preprints, patents, and grey literature address the same claim?

Use separate queries so a mechanism search is not mistaken for a novelty search.

## Question structures

Choose a structure matched to the question:

- PICO/PICOT: population, intervention, comparator, outcome, optional time;
- PECO: population, exposure, comparator, outcome;
- diagnostic: population, index test, reference standard, target condition;
- prognostic: population, prognostic factor, outcome, time;
- qualitative: population/sample, phenomenon, context;
- mechanistic: system, perturbation/condition, mediator/process, observable outcome;
- computational/theoretical: model class, assumptions, parameter regime, predicted observable.

Cochrane uses PICO for intervention-effect review questions and distinguishes review PICO, PICO for each synthesis, and PICO of included studies. Do not force PICO onto every domain.

## Source priority

Prefer the source closest to the claim:

1. law, regulation, official policy, or current institutional guidance for governance claims;
2. original paper, protocol, dataset, standard, or methods source for primary claims;
3. current reporting guideline and explanation/elaboration for reporting expectations;
4. systematic review or consensus report for landscape orientation;
5. narrative review for terminology and citation mining;
6. preprint or conference abstract, clearly labeled, for recent unreviewed work;
7. secondary webpages only when they point to a primary source or document current implementation.

Authority does not replace critical appraisal. A primary study may be weak, and a current official policy may be jurisdiction-specific.

## Search sequence

### 1. Broad orientation

- Search the phenomenon and field terminology.
- Locate one or more current reviews or consensus documents.
- Extract synonyms, controlled vocabulary, candidate mechanisms, and landmark sources.

### 2. Primary evidence

- Search each candidate mechanism separately.
- Search the original observation and closest analogues.
- Search prospective, experimental, longitudinal, and replication evidence where relevant.
- Search measurement-validation papers for each operationalization.

### 3. Rival and falsification search

For every candidate, run terms such as:

- alternative explanation;
- confounding;
- selection bias;
- collider bias;
- reverse causation;
- measurement error/artifact;
- negative control;
- failed replication;
- null or contradictory result;
- boundary condition/effect modification.

Record whether a source challenges the mechanism, the measurement, the design, or only its generalizability.

### 4. Foundational and historical search

Use backward citation tracing from methods and review papers. Search original titles, authors, books, standards, and DOI/PMID records. Recency is not a proxy for relevance.

### 5. Forward citation and registration search

Use citation indexes, trial registries, preregistration repositories, preprint servers, data/code repositories, and correction/retraction records as appropriate.

### 6. Policy search

Use current official sites and record:

- jurisdiction and applicability;
- effective or revision date;
- superseded documents;
- local implementation requirements;
- date checked.

For high-consequence work, a search result is not legal, regulatory, ethics, biosafety, or dual-use clearance.

## Search documentation

Complete `assets/search_boundary_template.json`. At minimum include:

- `search_boundary_id`;
- `searched_on`;
- purpose;
- databases/indexes;
- exact queries or reproducible query descriptions;
- date/language/source-type limits;
- inclusion and exclusion scope;
- stop rule or last result screened;
- known access and coverage limitations;
- novelty status.

Use `novelty_status: not_assessed` unless a qualified human has reviewed a fit-for-purpose search. Even a comprehensive search supports only a bounded statement.

## Evidence ledger

Complete `assets/evidence_ledger_template.csv` with one row per source:

- stable source ID;
- linked claim IDs;
- title and author/organization;
- publication date;
- source type and identifier;
- canonical HTTPS URL;
- access date;
- relation: supportive, challenging, contextual, method, safety, or mixed;
- design/document type;
- limitations and notes.

The audit validates structure and links only:

```bash
python3 scripts/audit_evidence_ledger.py \
  local-evidence-ledger.csv \
  local-search-boundary.json \
  --record local-hypothesis-record.json
```

It does not visit URLs, verify existence, appraise evidence, or decide whether a citation supports a claim.

## Claim-to-source notes

For each consequential claim, record:

- the exact source location (section, table, figure, page, or quoted sentence);
- whether the evidence is direct, indirect, analogous, or contradictory;
- study design and target population/system;
- magnitude and uncertainty actually reported;
- key limitations and conflicts;
- applicability to the candidate.

Verify every identifier and claim against the source. Do not rely on search snippets or AI-generated citations.

## Search stopping

Use a documented stop rule, such as:

- all prespecified databases searched;
- a fixed result depth screened per query;
- forward/backward citation tracing completed for named seed sources;
- predefined date and language boundary reached;
- saturation documented for terminology or mechanisms.

Do not stop merely because:

- preferred evidence was found;
- new results seem repetitive;
- a citation count is high;
- a source appears in a prestigious venue.

## Reporting bounded conclusions

Use:

> Searches were conducted on YYYY-MM-DD in [indexes] using [queries/strategy]. Within the documented date, language, access, and screening limits, we located [scope]. This does not establish universal absence, priority, or novelty.

For gaps:

> No directly matching source was located within the documented search boundary. Related work was found on [near neighbors]. A broader specialist search is required before making a novelty claim.

## Common failures

- Treating impact factor or citation count as study validity
- Searching only for support
- Using only one database
- Ignoring terminology changes or historical work
- Citing a review for a claim that should cite the primary study
- Treating preprints as peer-reviewed
- Omitting corrections, retractions, or protocol/registration records
- Searching confidential text verbatim
- Claiming an exhaustive search without a reproducible protocol
- Conflating “not found” with “does not exist”
