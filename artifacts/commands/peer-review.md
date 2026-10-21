Review a change authored by someone else: a PR, MR, or branch on origin. The review runs the full thatch review pipeline with findings weighted for org velocity.

${COUCHING:target}

${COUCHING:pipeline}

## Peer review mode rules

- Weight for org velocity. Findings that speed up or unblock the whole team outrank findings about individual lines. The highest-value findings: a simpler method that achieves the same outcome; an existing function or helper that already does what this change reimplements; documentation that is accurate and extremely clearly written; unintended consequences for callers, sibling features, or contracts the author could not see.
- Walk the project's memory. The author does not have this project's persistent memory; you do. During context gathering, call ${TOOL:memory_recall} with several phrasings about the touched area: past incidents, design constraints, rejected approaches, known footguns. Check each recalled item against the change and report the ones that apply. Frame these findings as sharing knowledge the author could not have had, not as catching mistakes.
- Do not re-litigate settled designs. When the context brief or memory shows a design decision was agreed (in a ticket discussion, a prior review acceptance, recorded docs, or a memory of the agreement), treat the decision as settled. Findings may address how the change implements that decision. Findings that argue the decision itself was wrong are out of scope for this review.
- Never report findings of the form "if someone changes this in the future, it will silently break." This review does not solve for engineers who change code without reading it. It solves for engineers and LLMs who WILL read the code. For them, verify the change leaves a breadcrumb trail to wherever this organization records how a feature works (a context module, a feature doc, a README). Flag a missing trail. Do not flag hypothetical future misuse.
