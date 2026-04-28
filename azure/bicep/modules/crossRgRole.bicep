// Cross-RG role assignment. Deployed at the *lab* RG scope (dsc-v3) and
// grants the UAMI (created in the dashboard RG) the rights it needs to
// invoke Run-Command on the lab VMs.
//
// Built-in role: Virtual Machine Contributor.
// https://learn.microsoft.com/azure/role-based-access-control/built-in-roles#virtual-machine-contributor

@description('PrincipalId of the UAMI from the dashboard RG.')
param principalId string

var vmContributorRoleId = '9980e02c-c2be-4d73-94e8-173b1dc7cf3c'

resource ra 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  // guid(scope.id, principalId, roleId) — stable so re-deploy is idempotent.
  name: guid(resourceGroup().id, principalId, vmContributorRoleId)
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', vmContributorRoleId)
  }
}
