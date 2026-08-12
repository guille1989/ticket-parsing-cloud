import { CognitoIdentityProviderClient, ListUsersCommand, type UserType } from "@aws-sdk/client-cognito-identity-provider";

/**
 * Cognito `ListUsersCommand` NO soporta filtrar por atributos custom (solo
 * email/username/phone_number/etc. — se probó en la práctica, tira
 * `InvalidParameterException` con `custom:tenantId`) — así que la única
 * forma de encontrar el/los usuario(s) de un tenant es traer todos los
 * usuarios del pool (paginado) y filtrar acá. Aceptable para un pool chico
 * (uno o pocos usuarios por tenant, testing phase) — si el pool crece
 * mucho, esto deja de ser gratis y hay que resolverlo distinto (ej. un
 * índice propio en DynamoDB al crear el usuario).
 */
export async function findTenantUsers(cognito: CognitoIdentityProviderClient, userPoolId: string, tenantId: string): Promise<UserType[]> {
  const matches: UserType[] = [];
  let paginationToken: string | undefined;
  do {
    const page = await cognito.send(new ListUsersCommand({ UserPoolId: userPoolId, PaginationToken: paginationToken }));
    for (const user of page.Users ?? []) {
      const userTenantId = user.Attributes?.find((a) => a.Name === "custom:tenantId")?.Value;
      if (userTenantId === tenantId) matches.push(user);
    }
    paginationToken = page.PaginationToken;
  } while (paginationToken);
  return matches;
}
