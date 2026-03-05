"use client"

import { useTranslations } from "next-intl"
import Link from "next/link"
import { useState } from "react"

interface SwitchProposal {
  id: string
  sellStockName: string
  sellTickerCode: string
  sellStockId: string
  sellRecoveryScore: number
  buyStockName: string
  buyTickerCode: string
  buyStockId: string
  buyOpportunityScore: number
  switchBenefit: number
  reason: string
  userAction: string | null
}

interface SwitchProposalCardProps {
  proposals: SwitchProposal[]
}

export default function SwitchProposalCard({ proposals }: SwitchProposalCardProps) {
  const t = useTranslations("dashboard.marketNavigator.switchProposal")

  if (proposals.length === 0) return null

  return (
    <div className="space-y-2">
      <h4 className="text-sm font-bold text-foreground">
        {t("title")}
      </h4>
      {proposals.map((proposal) => (
        <ProposalItem key={proposal.id} proposal={proposal} t={t} />
      ))}
    </div>
  )
}

function ProposalItem({
  proposal,
  t,
}: {
  proposal: SwitchProposal
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any
}) {
  const [action, setAction] = useState<string | null>(proposal.userAction)
  const [loading, setLoading] = useState(false)

  const handleAction = async (userAction: string) => {
    setLoading(true)
    try {
      const res = await fetch(`/api/switch-proposals/${proposal.id}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: userAction }),
      })
      if (res.ok) setAction(userAction)
    } finally {
      setLoading(false)
    }
  }

  if (action) return null

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3 dark:border-amber-800 dark:bg-amber-950/20">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-base">💡</span>
        <span className="text-xs font-medium text-amber-700 dark:text-amber-400">
          {t("benefitLabel", { value: Math.round(proposal.switchBenefit) })}
        </span>
      </div>
      <div className="mb-2 flex items-center justify-between text-xs">
        <Link
          href={`/my-stocks/${proposal.sellStockId}`}
          className="flex-1 text-center"
        >
          <div className="font-medium text-red-600 dark:text-red-400">
            {proposal.sellStockName}
          </div>
          <div className="text-muted-foreground">
            {t("recoveryScore", { value: Math.round(proposal.sellRecoveryScore) })}
          </div>
        </Link>
        <div className="mx-2 text-muted-foreground">→</div>
        <Link
          href={`/stocks/${proposal.buyStockId}`}
          className="flex-1 text-center"
        >
          <div className="font-medium text-green-600 dark:text-green-400">
            {proposal.buyStockName}
          </div>
          <div className="text-muted-foreground">
            {t("opportunityScore", { value: Math.round(proposal.buyOpportunityScore) })}
          </div>
        </Link>
      </div>
      <p className="mb-2 text-xs text-muted-foreground">{proposal.reason}</p>
      <div className="flex gap-2">
        <button
          onClick={() => handleAction("rejected")}
          disabled={loading}
          className="flex-1 rounded border border-muted-foreground/20 px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
        >
          {t("dismiss")}
        </button>
        <Link
          href={`/stocks/${proposal.buyStockId}`}
          className="flex-1 rounded bg-primary px-2 py-1 text-center text-xs text-primary-foreground hover:bg-primary/90"
        >
          {t("viewDetail")}
        </Link>
      </div>
    </div>
  )
}
