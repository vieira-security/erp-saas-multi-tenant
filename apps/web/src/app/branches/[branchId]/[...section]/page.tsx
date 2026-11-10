import { SectionPage } from "../../../../components/section-page";

export default async function BranchSectionPage({ params }: { params: Promise<{ section: string[] }> }) {
  const { section } = await params;
  return <SectionPage segment={section.map((part) => decodeURIComponent(part)).join("/")} />;
}
