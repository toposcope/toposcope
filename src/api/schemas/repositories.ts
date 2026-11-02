import * as v from "valibot";
import { optionalText, requiredText } from "./common";

export const repositoryBody = v.object({
  url: requiredText("The repository: https://host/owner/name, host/owner/name or git@host:owner/name.", "url is required"),
  path: optionalText("The folder the service's stack paths start in, like services/pay; empty for the root. Left out, it stays while the repository does."),
});

export const codeQuery = v.object({
  mark: optionalText("A deploy mark's id: the answer has its service's repository and the previous deploy of that service."),
  service: optionalText("A service, when there is no mark: the answer has its repository."),
  version: optionalText("With service: the deploy mark whose version this is."),
});
