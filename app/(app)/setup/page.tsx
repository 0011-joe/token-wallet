import { SetupWizard } from "@/components/setup/setup-wizard";

export const metadata = { title: "Deploy 向导 · token-wallet" };

export default function SetupPage() {
  return (
    <div className="py-8">
      <SetupWizard />
    </div>
  );
}
