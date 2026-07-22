import { BriefcaseBusiness, LineChart, Scale, ShieldCheck, UsersRound } from "lucide-react";

export function TeamIcon({ team }: { team: string }) {
  const className = "size-5";
  if (team === "Analyst Team") return <LineChart className={className} />;
  if (team === "Research Team") return <UsersRound className={className} />;
  if (team === "Trading Team") return <BriefcaseBusiness className={className} />;
  if (team === "Risk Management") return <ShieldCheck className={className} />;
  if (team === "Portfolio") return <Scale className={className} />;
  return <UsersRound className={className} />;
}
