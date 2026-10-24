import type { IndicatorSnapshot } from './indicators'

export interface ScoreReason {
  label: string
  points: number
}

export type SignalLabel =
  | 'Achat fort'
  | 'Renfort'
  | 'Neutre'
  | 'Alléger'
  | 'Vente'

export interface SignalScore {
  score: number
  label: SignalLabel
  reasonsFor: ScoreReason[]
  reasonsAgainst: ScoreReason[]
  reasonsInfo: ScoreReason[]
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function labelFromScore(score: number): SignalLabel {
  if (score >= 50) return 'Achat fort'
  if (score >= 20) return 'Renfort'
  if (score <= -50) return 'Vente'
  if (score <= -20) return 'Alléger'
  return 'Neutre'
}

/**
 * Composite buy/sell score from an indicator snapshot (−100…+100).
 * Transparent reasons for the UI popover.
 */
export function scoreFromIndicators(ind: IndicatorSnapshot): SignalScore {
  const reasonsFor: ScoreReason[] = []
  const reasonsAgainst: ScoreReason[] = []
  const reasonsInfo: ScoreReason[] = []
  let score = 0

  if (ind.regime === 'bull') {
    reasonsFor.push({ label: 'Régime haussier (MM49 > MM190, pente ≥ 0)', points: 25 })
    score += 25
  } else if (ind.regime === 'bear') {
    reasonsAgainst.push({
      label: 'Régime baissier (MM49 < MM190, pente < 0)',
      points: -25,
    })
    score -= 25
  } else {
    reasonsInfo.push({ label: 'Régime neutre', points: 0 })
  }

  // Strong buy: RSI reclaim + support bounce (+ volume)
  if (ind.rsiReclaimAbove30 && ind.bounceSupport) {
    if (ind.volumeConfirm === false) {
      reasonsFor.push({
        label: 'RSI réintégré + rebond support (volume faible)',
        points: 20,
      })
      score += 20
      reasonsAgainst.push({ label: 'Volume sous la moyenne (×1,5)', points: 0 })
    } else {
      reasonsFor.push({
        label:
          ind.volumeConfirm === true
            ? 'RSI réintégré + rebond support + volume'
            : 'RSI réintégré + rebond support',
        points: 40,
      })
      score += 40
    }
  } else {
    if (ind.rsiReclaimAbove30) {
      reasonsFor.push({ label: 'RSI réintégré au-dessus de 30', points: 10 })
      score += 10
    }
    if (ind.bounceSupport) {
      reasonsFor.push({ label: 'Rebond sur support pivot', points: 10 })
      score += 10
    }
  }

  if (ind.goldenCross) {
    reasonsFor.push({ label: 'Golden cross MM49 / MM190', points: 20 })
    score += 20
  }

  if (ind.rsiReclaimBelow70) {
    reasonsAgainst.push({ label: 'RSI réintégré sous 70 (surachat)', points: -30 })
    score -= 30
  }
  if (ind.deathCross) {
    reasonsAgainst.push({ label: 'Death cross MM49 / MM190', points: -25 })
    score -= 25
  }
  if (ind.breakSupport) {
    reasonsAgainst.push({ label: 'Cassure du support pivot', points: -35 })
    score -= 35
  }

  if (ind.volumeConfirm === undefined) {
    reasonsInfo.push({ label: 'Volume n/a (série sans volume)', points: 0 })
  } else if (ind.volumeConfirm === true && !(ind.rsiReclaimAbove30 && ind.bounceSupport)) {
    reasonsInfo.push({ label: 'Volume au-dessus de la moyenne', points: 0 })
  }

  score = clamp(Math.round(score), -100, 100)
  return {
    score,
    label: labelFromScore(score),
    reasonsFor,
    reasonsAgainst,
    reasonsInfo,
  }
}
