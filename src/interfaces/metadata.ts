


export interface ISecurityInfo {
  view: IPermissionBundle[]
  edit: IPermissionBundle[]
}

export interface IPermissionBundle {
  address: string,
  key: string
}