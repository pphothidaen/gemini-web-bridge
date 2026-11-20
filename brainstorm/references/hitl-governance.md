# HITL Governance — Brainstorm Skill Controls

## Overview

This document defines **Human-In-The-Loop (HITL) controls** for the Brainstorm Skill. These controls ensure proper human oversight for architectural decisions, confidence validation, and escalation paths throughout the 4-phase review process.

**Governance Principles**:
- **No blind autonomy**: Automated findings require human confidence validation
- **Escalation hierarchy**: Tiered review process from initial human check to final architect approval
- **Audit trail**: All HITL decisions logged with rationale and timestamps
- **Bypass controls**: Limited bypass authority for urgent tactical changes only

## HITL Integration Points

### Phase 1: Orchestrator Framing — HITL Checkpoint 1

**Control**: Human Architect Requirement Validation

```python
# hitl_checkpoint_1.py
def validate_framing_requirements(problem_statement, constraints, criteria):
    """
    HITL Checkpoint 1: Verify framing completeness before proceeding
    
    This checkpoint ensures human oversight of requirement definition
    before any automated analysis begins.
    """
    
    # 1. Zero Ambiguity (E3) — Human validation required
    if contains_ambiguous_terms(problem_statement):
        return {
            "status": "REJECTED",
            "reason": "Problem statement contains ambiguous terms",
            "human_required": True,
            "escalation": "architect-review"
        }
    
    # 2. Stakeholder alignment — Human validation
    if not contains_stakeholder_context(problem_statement):
        return {
            "status": "REJECTED", 
            "reason": "Problem statement lacks stakeholder context",
            "human_required": True,
            "escalation": "architect-review"
        }
    
    # 3. Constraint completeness — Human validation
    required_constraints = ['latency', 'cost', 'security', 'compatibility']
    missing = [c for c in required_constraints if c not in constraints.lower()]
    if missing:
        return {
            "status": "REJECTED",
            "reason": f"Missing constraints: {missing}",
            "human_required": True,
            "escalation": "architect-review"
        }
    
    # 4. Decision criteria crystalized — Human validation
    if not criteria:
        return {
            "status": "REJECTED",
            "reason": "Decision criteria not specified",
            "human_required": True,
            "escalation": "architect-review"
        }
    
    # All validations passed — record human approval
    return {
        "status": "HITL_APPROVED",
        "human_validator": "architect-name",
        "timestamp": datetime.now().isoformat(),
        "rationale": "All framing requirements validated by human architect",
        "confidence_boost": "manual_validation"
    }
```

**HITL Approval Matrix**:

| Validation Point | Auto-Confidence | Human Required | Approval Authority | Escalation Path |
|------------------|----------------|----------------|-------------------|-----------------|
| Zero Ambiguity (E3) | 0.30 | ✅ Required | Lead Architect | Direct to architect review |
| Stakeholder Context | 0.40 | ✅ Required | Lead Architect | Direct to architect review |
| Constraint Completeness | 0.35 | ✅ Required | Lead Architect | Direct to architect review |
| Decision Criteria | 0.25 | ✅ Required | Lead Architect | Direct to architect review |

**E3 Gate Check Enhancement**:
```python
# Enhanced E3 with HITL controls
def e3_gate_with_hitl(problem, constraints, criteria, risks):
    # Run automated checks first
    auto_validation = run_e3_checks(problem, constraints, criteria, risks)
    
    if not auto_validation.passed:
        # HITL escalation for failed checks
        return {
            "status": "HITL_ESCALATION_REQUIRED",
            "failure_points": auto_validation.failures,
            "human_approver": "lead-architect",
            "escalation_reason": "E3 gate failed automated validation",
            "deadline": "24h",
            "fallback": "architect-review-needed"
        }
    
    # HITL confidence boost for successful checks
    if auto_validation.high_confidence:
        return {
            "status": "HITL_APPROVED",
            "auto_validation": auto_validation,
            "human_approver": "lead-architect", 
            "confidence_boost": "hitl_validation_passed",
            "proceed": True
        }
    
    return auto_validation
```

### Phase 2: Parallel Perspective Dispatch — HITL Checkpoint 2

**Control**: Confidence Scoring and Human Validation

```python
# hitl_checkpoint_2.py  
def score_and_validate_findings(phase2_findings):
    """
    HITL Checkpoint 2: Score automated findings and validate with human review
    """
    
    confidence_scores = {}
    human_interventions = []
    
    for role, findings in phase2_findings.items():
        # 1. Automated confidence scoring
        confidence_score = calculate_confidence(findings)
        
        # 2. HITL trigger based on confidence thresholds
        if confidence_score < HITL_THRESHOLDS[role]:
            confidence_scores[role] = {
                "score": confidence_score,
                "status": "HITL_REQUIRED",
                "reason": f"Confidence {confidence_score} < threshold {HITL_THRESHOLDS[role]}",
                "human_approver": get_hitl_approver(role),
                "deadline": "12h"
            }
            human_interventions.append({
                "role": role,
                "findings": findings,
                "approval_required": True
            })
        else:
            confidence_scores[role] = {
                "score": confidence_score, 
                "status": "HITL_AUTO_APPROVED",
                "reason": f"Confidence {confidence_score} meets threshold",
                "human_approver": None,
                "auto_approved": True
            }
    
    return {
        "confidence_scores": confidence_scores,
        "human_interventions": human_interventions,
        "overall_status": determine_overall_status(confidence_scores),
        "escalation_required": len(human_interventions) > 0
    }
```

**HITL Confidence Thresholds**:

| Role | Auto Confidence | HITL Required | Human Approver | Threshold Rationale |
|------|-----------------|----------------|----------------|-------------------|
| Red Team | 0.60 | ✅ Required | Security Architect | Low confidence = high risk |
| Blue Team | 0.70 | ✅ Required | Infrastructure Architect | Medium confidence = some risk |
| Worker Specialist | 0.75 | ⚠️ Optional | DevOps Lead | Higher confidence expected |
| Research | 0.80 | ⚠️ Optional | Technical Lead | High confidence expected |

**HITL Escalation Flow**:
```python
# hitl_escalation_manager.py
def handle_hitl_escalation(interventions):
    """
    Centralized HITL escalation manager with priority queue
    """
    
    # Sort by urgency and blast radius
    prioritized = sort_interventions_by_urgency(interventions)
    
    for intervention in prioritized:
        if intervention['urgency'] == 'CRITICAL':
            # Immediate escalation to lead architect
            escalate_to_lead_architect(intervention)
            continue
        
        if intervention['urgency'] == 'HIGH':
            # Escalation to technical lead within 2 hours
            escalate_to_technical_lead(intervention, deadline="2h")
            continue
        
        # Standard queue for medium/low urgency
        add_to_standard_hitl_queue(intervention)
    
    return {
        "total_interventions": len(interventions),
        "critical_count": count_critical(prioritized),
        "high_count": count_high(prioritized),
        "queued_count": count_standard(prioritized),
        "status": "HITL_MANAGEMENT_ACTIVE"
    }
```

### Phase 3: Synthesis & Trade-off Matrix — HITL Checkpoint 3

**Control**: Human Trade-off Matrix Validation

```python
# hitl_checkpoint_3.py
def validate_tradeoff_matrix(matrix):
    """
    HITL Checkpoint 3: Human validation of trade-off matrix analysis
    """
    
    # 1. Automated matrix completeness check
    if not matrix.is_complete():
        return {
            "status": "HITL_REQUIRED",
            "reason": "Trade-off matrix incomplete",
            "missing_elements": matrix.get_missing_elements(),
            "human_approver": "technical-lead",
            "deadline": "6h"
        }
    
    # 2. HITL risk assessment
    risk_assessment = perform_hitl_risk_assessment(matrix)
    
    if risk_assessment.high_risk:
        return {
            "status": "HITL_CRITICAL",
            "reason": "High risk trade-offs detected",
            "risk_details": risk_assessment.risk_details,
            "human_approver": "lead-architect",
            "deadline": "4h",
            "escalation": "architecture-review-board"
        }
    
    # 3. Human validation of trade-off logic
    human_validation = human_review_tradeoffs(matrix, risk_assessment)
    
    return {
        "status": "HITL_APPROVED" if human_validation.passed else "HITL_REJECTED",
        "matrix_validation": human_validation,
        "risk_assessment": risk_assessment,
        "human_approver": "technical-lead",
        "rationale": human_validation.rationale
    }
```

### Phase 4: Decision & Rationale — HITL Checkpoint 4

**Control**: Final Human Decision Approval

```python
# hitl_checkpoint_4.py
def final_decision_approval(phase3_synthesis):
    """
    HITL Checkpoint 4: Final human decision approval and escalation handling
    """
    
    # 1. Create human decision interface
    human_decision_form = create_decision_form(phase3_synthesis)
    
    # 2. Multi-level approval workflow
    approval_workflow = {
        "level_1": "domain-owner",
        "level_2": "technical-lead", 
        "level_3": "lead-architect",
        "final": "architecture-council"
    }
    
    # 3. Escalation rules
    escalation_rules = {
        "blast_radius": {
            "medium": "level_2",
            "high": "level_3", 
            "critical": "architecture-council"
        },
        "confidence_score": {
            "low": "level_2",
            "medium": "level_3",
            "high": "auto-approve"
        }
    }
    
    # 4. Final approval recording
    final_approval = human_decision_form.get_approval(approval_workflow)
    
    return {
        "status": "HITL_FINAL_APPROVAL",
        "approved_by": final_approval.approved_by,
        "rationale": final_approval.rationale,
        "timestamp": final_approval.timestamp,
        "escalation_required": final_approval.escalation_required,
        "audit_entry": create_audit_log_entry(phase3_synthesis, final_approval)
    }
```

## HITL Bypass Controls

**Purpose**: Limited bypass authority for urgent tactical changes that cannot wait for full HITL process.

```python
# hitl_bypass.py
def hitl_bypass_control(review_ticket):
    """
    Controlled HITL bypass for urgent tactical changes
    """
    
    bypass_criteria = {
        "urgency": {
            "immediate": "critical_security_fix",
            "emergency": "data_loss_prevention",
            "time_sensitive": "market_deadline"
        },
        "impact": {
            "single_system": "devops_lead",
            "small_scale": "technical_lead",
            "contained": "project_manager"
        }
    }
    
    # Validation: Must pass all bypass checks
    if not (is_urgent(review_ticket) and is_contained(review_ticket)):
        return {
            "status": "HITL_BYPASS_DENIED",
            "reason": "Does not meet bypass criteria",
            "alternative": "Standard HITL process required"
        }
    
    # Emergency approval required
    emergency_approval = get_emergency_approval(review_ticket)
    
    return {
        "status": "HITL_BYPASS_APPROVED",
        "emergency_approval": emergency_approval,
        "duration": "72h maximum",
        "conditions": ["must_report_within_24h", "must_followup_with_full_review"],
        "escalation": "architect-council"
    }
```

## Audit and Compliance

**HITL Audit Trail**:
```python
# hitl_audit_log.py
def log_hitl_decision(decision_details):
    """
    Comprehensive HITL audit logging for compliance
    """
    
    audit_entry = {
        "timestamp": datetime.now().isoformat(),
        "ticket_id": decision_details.ticket_id,
        "phase": decision_details.phase,
        "human_approver": decision_details.human_approver,
        "auto_confidence": decision_details.auto_confidence,
        "hitl_validation": decision_details.hitl_validation,
        "rationale": decision_details.rationale,
        "escalation_required": decision_details.escalation_required,
        "bypass_used": decision_details.bypass_used,
        "compliance_check": "hitl_governance_v2.1",
        "next_review_due": calculate_next_review()
    }
    
    # Log to immutable audit store
    write_to_audit_store(audit_entry)
    
    # Trigger compliance alerts if needed
    if audit_entry['escalation_required']:
        trigger_compliance_alert(audit_entry)
    
    return {
        "status": "HITL_AUDIT_LOGGED",
        "audit_id": audit_entry['audit_id'],
        "compliance_status": "green"
    }
```

## Configuration

**HITL Settings**:
```yaml
# .hitl-config.yaml
hitl_governance:
  enabled: true
  confidence_thresholds:
    red_team: 0.60
    blue_team: 0.70  
    worker_specialist: 0.75
    research: 0.80
  
  escalation_rules:
    critical_breach: "lead_architect"
    high_breach: "technical_lead"
    medium_breach: "devops_lead"
  
  bypass_authority:
    emergency_tactical: "project_manager"
    time_sensitive: "technical_lead"
    urgent: "devops_lead"
  
  audit_logging:
    retention_days: 2555  # 7 years
    encryption_required: true
    immutable_storage: true
```

## Summary

The HITL-enhanced Brainstorm Skill now includes:

1. **4 HITL checkpoints** throughout the review process
2. **Escalation hierarchy** from domain owners to architecture councils
3. **Confidence validation** with human approval triggers
4. **Controlled bypass** for urgent tactical changes
5. **Comprehensive audit logging** for compliance
6. **Multi-level approval workflows** based on risk and impact

This ensures proper human oversight while maintaining the benefits of structured cross-functional review, with clear escalation paths when automated confidence thresholds are not met.