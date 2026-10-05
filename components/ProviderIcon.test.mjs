import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { ProviderIcon } = await createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
}).import("./ProviderIcon.tsx");

for (const id of ["azure", "azure-openai-responses"]) {
  test(`Azure provider icon supports ${id} without renaming historical credentials`, () => {
    const icon = ProviderIcon({ id, size: 18 });
    assert.equal(icon.type, "svg");
    assert.equal(icon.props.children.type, "use");
    assert.equal(icon.props.children.props.href, "/provider-icons.svg#azure");
  });
}
