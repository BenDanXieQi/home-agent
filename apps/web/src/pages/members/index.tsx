import { MemberAccess } from "./MemberAccess";
import { MemberBrowser } from "./MemberBrowser";

export default function MembersPage() {
  return (
    <MemberAccess>
      {(scope) => <MemberBrowser key={scope} scope={scope} />}
    </MemberAccess>
  );
}
