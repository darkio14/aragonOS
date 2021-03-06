const assertEvent = require('./helpers/assertEvent')
const { assertRevert } = require('./helpers/assertThrow')
const { hash } = require('eth-ens-namehash')
const { soliditySha3 } = require('web3-utils')

const ACL = artifacts.require('ACL')
const Kernel = artifacts.require('Kernel')
const KernelProxy = artifacts.require('KernelProxy')

// Mocks
const AppStub = artifacts.require('AppStub')
const APP_ID = hash('stub.aragonpm.test')

contract('Kernel ACL', accounts => {
    let aclBase, appBase
    let APP_MANAGER_ROLE, APP_BASES_NAMESPACE, ACL_APP_ID, ANY_ENTITY

    const permissionsRoot = accounts[0]
    const granted = accounts[1]
    const child = accounts[2]
    const noPermissions = accounts[8]

    // Initial setup
    before(async () => {
        aclBase = await ACL.new()
        appBase = await AppStub.new()

        // Setup constants
        const kernel = await Kernel.new(true)
        APP_BASES_NAMESPACE = await kernel.APP_BASES_NAMESPACE()
        APP_MANAGER_ROLE = await kernel.APP_MANAGER_ROLE()
        ACL_APP_ID = await kernel.ACL_APP_ID()
        ANY_ENTITY = await aclBase.ANY_ENTITY()
    })

    // Test both the Kernel itself and the KernelProxy to make sure their behaviours are the same
    for (const kernelType of ['Kernel', 'KernelProxy']) {
        context(`> ${kernelType}`, () => {
            let kernelBase, acl, kernel, kernelAddr

            before(async () => {
                if (kernelType === 'KernelProxy') {
                    // We can reuse the same kernel base for the proxies
                    kernelBase = await Kernel.new(true) // petrify immediately
                }
            })

            beforeEach(async () => {
                if (kernelType === 'Kernel') {
                    kernel = await Kernel.new(false) // don't petrify so it can be used
                } else if (kernelType === 'KernelProxy') {
                    kernel = Kernel.at((await KernelProxy.new(kernelBase.address)).address)
                }

                await kernel.initialize(aclBase.address, permissionsRoot);
                acl = ACL.at(await kernel.acl())
                kernelAddr = kernel.address
            })

            it('cannot initialize base ACL', async () => {
                const newAcl = await ACL.new()
                assert.isTrue(await newAcl.isPetrified())
                return assertRevert(async () => {
                    await newAcl.initialize(permissionsRoot)
                })
            })

            it('cannot initialize proxied ACL outside of Kernel', async () => {
                // Set up ACL proxy
                await acl.createPermission(permissionsRoot, kernelAddr, APP_MANAGER_ROLE, permissionsRoot)
                const receipt = await kernel.newAppInstance(ACL_APP_ID, aclBase.address)
                const newAcl = ACL.at(receipt.logs.filter(l => l.event == 'NewAppProxy')[0].args.proxy)

                return assertRevert(async () => {
                    await newAcl.initialize(permissionsRoot)
                })
            })

            it('cannot perform actions by default', async () => {
                assert.isFalse(await acl.hasPermission(permissionsRoot, noPermissions, APP_MANAGER_ROLE))
            })

            it('cannot perform protected actions if not allowed', async () => {
                return assertRevert(async () => {
                    await kernel.setApp(APP_BASES_NAMESPACE, APP_ID, appBase.address, { from: noPermissions })
                })
            })

            it('create permission action can be performed by root by default', async () => {
                const createPermissionRole = await acl.CREATE_PERMISSIONS_ROLE()
                assert.isTrue(await acl.hasPermission(permissionsRoot, acl.address, createPermissionRole))
            })

            it('cannot create permissions without permission', async () => {
                return assertRevert(async () => {
                    await acl.createPermission(granted, noPermissions, APP_MANAGER_ROLE, granted, { from: noPermissions })
                })
            })

            context('> creating permission', () => {
                beforeEach(async () => {
                    const receipt = await acl.createPermission(granted, kernelAddr, APP_MANAGER_ROLE, granted, { from: permissionsRoot })
                    assertEvent(receipt, 'SetPermission')
                    assertEvent(receipt, 'SetPermissionParams', 0) // should not have emitted this
                    assertEvent(receipt, 'ChangePermissionManager')
                })

                it('has permission', async () => {
                    assert.isTrue(await acl.hasPermission(granted, kernelAddr, APP_MANAGER_ROLE))
                })

                it('can execute action', async () => {
                    const receipt = await kernel.setApp('0x1234', APP_ID, appBase.address, { from: granted })
                    assertEvent(receipt, 'SetApp')
                })

                it('can grant permission with params', async () => {
                    const secondChild = accounts[3]

                    // Set role such that the first param cannot be equal to 0
                    // For APP_MANAGER_ROLE, this is the namespace
                    // param hash 0x68b4adfe8175b29530f1c715f147337823f4ae55693be119bef69129637d681f
                    const argId = '0x00' // arg 0
                    const op = '02'      // not equal
                    const value = '000000000000000000000000000000000000000000000000000000000000'  // namespace 0
                    const param = new web3.BigNumber(`${argId}${op}${value}`)

                    const grantChildReceipt = await acl.grantPermissionP(child, kernelAddr, APP_MANAGER_ROLE, [param], { from: granted })

                    // Retrieve the params back with the getters
                    const numParams = await acl.getPermissionParamsLength(child, kernelAddr, APP_MANAGER_ROLE)
                    assert.equal(numParams, 1, 'There should be just 1 param')
                    const returnedParam = await acl.getPermissionParam(child, kernelAddr, APP_MANAGER_ROLE, 0)
                    assert.equal(returnedParam[0].valueOf(), parseInt(argId, 16), 'param id should match')
                    assert.equal(returnedParam[1].valueOf(), parseInt(op, 10), 'param op should match')
                    assert.equal(returnedParam[2].valueOf(), parseInt(value, 10), 'param value should match')

                    // Assert that the right events have been emitted with the right args
                    assertEvent(grantChildReceipt, 'SetPermission')
                    assertEvent(grantChildReceipt, 'SetPermissionParams')
                    const setParamsHash = grantChildReceipt.logs.filter(l => l.event == 'SetPermissionParams')[0].args.paramsHash
                    assert.equal(setParamsHash, soliditySha3(param))

                    // Grants again without re-saving params (saves gas)
                    const grantSecondChildReceipt = await acl.grantPermissionP(secondChild, kernelAddr, APP_MANAGER_ROLE, [param], { from: granted })
                    assert.isBelow(
                        grantSecondChildReceipt.receipt.gasUsed,
                        grantChildReceipt.receipt.gasUsed,
                        'should have used less gas because of cache'
                    )

                    // Allows setting code for namespace other than 0
                    for (grantee of [child, secondChild]) {
                        const receipt = await kernel.setApp('0x121212', '0x0', appBase.address, { from: grantee })
                        assertEvent(receipt, 'SetApp')
                    }

                    // Fail if setting code for namespace 0
                    for (grantee of [child, secondChild]) {
                        await assertRevert(async () => {
                            await kernel.setApp('0x0', APP_ID, appBase.address, { from: grantee })
                        })
                    }
                })

                it('can grant a public permission', async () => {
                    const receipt = await acl.grantPermission(ANY_ENTITY, kernelAddr, APP_MANAGER_ROLE, { from: granted })
                    assertEvent(receipt, 'SetPermission')
                    assertEvent(receipt, 'SetPermissionParams', 0) // should not have emitted this

                    // Any entity can succesfully perform action
                    for (granteeIndex of [4, 5, 6]) {
                        const grantee = accounts[granteeIndex]
                        assert.isTrue(await acl.hasPermission(grantee, kernelAddr, APP_MANAGER_ROLE), `account[${granteeIndex}] should have perm`)
                        const setReceipt = await kernel.setApp('0x121212', APP_ID, appBase.address, { from: grantee })
                        assertEvent(setReceipt, 'SetApp')
                    }
                })

                it('returns created permission', async () => {
                    const allowed = await acl.hasPermission(granted, kernelAddr, APP_MANAGER_ROLE)
                    const manager = await acl.getPermissionManager(kernelAddr, APP_MANAGER_ROLE)

                    assert.isTrue(allowed, 'entity should be allowed to perform role actions')
                    assert.equal(manager, granted, 'permission parent should be correct')
                })

                it('root cannot revoke permission', async () => {
                    return assertRevert(async () => {
                        await acl.revokePermission(granted, kernelAddr, APP_MANAGER_ROLE, { from: permissionsRoot })
                    })
                })

                it('root cannot re-create permission', async () => {
                    return assertRevert(async () => {
                        await acl.createPermission(granted, kernelAddr, APP_MANAGER_ROLE, granted, { from: permissionsRoot })
                    })
                })

                it('root cannot grant permission', async () => {
                    // Make sure child doesn't have permission yet
                    assert.isFalse(await acl.hasPermission(child, kernelAddr, APP_MANAGER_ROLE))
                    return assertRevert(async () => {
                        await acl.grantPermission(child, kernelAddr, APP_MANAGER_ROLE, { from: permissionsRoot })
                    })
                })

                context('> transferring managership', () => {
                    const newManager = accounts[3]
                    assert.notEqual(newManager, granted, 'newManager should not be the same as granted')

                    beforeEach(async () => {
                        const receipt = await acl.setPermissionManager(newManager, kernelAddr, APP_MANAGER_ROLE, { from: granted })
                        assertEvent(receipt, 'ChangePermissionManager')
                    })

                    it('changes manager', async () => {
                        const manager = await acl.getPermissionManager(kernelAddr, APP_MANAGER_ROLE)
                        assert.equal(manager, newManager, 'manager should have changed')
                    })

                    it('can grant permission', async () => {
                        const receipt = await acl.grantPermission(newManager, kernelAddr, APP_MANAGER_ROLE, { from: newManager })
                        assertEvent(receipt, 'SetPermission')
                    })

                    it("new manager doesn't have permission yet", async () => {
                        // It's only the manager–it hasn't granted itself permissions yet
                        assert.isFalse(await acl.hasPermission(newManager, kernelAddr, APP_MANAGER_ROLE))
                    })

                    it('old manager lost power', async () => {
                        return assertRevert(async () => {
                            await acl.grantPermission(newManager, kernelAddr, APP_MANAGER_ROLE, { from: granted })
                        })
                    })
                })

                context('> removing managership', () => {
                    const newManager = accounts[3]
                    assert.notEqual(newManager, granted, 'newManager should not be the same as granted')

                    beforeEach(async () => {
                        const receipt = await acl.removePermissionManager(kernelAddr, APP_MANAGER_ROLE, { from: granted })
                        assertEvent(receipt, 'ChangePermissionManager')
                    })

                    it('removes manager', async () => {
                        const noManager = await acl.getPermissionManager(kernelAddr, APP_MANAGER_ROLE)
                        assert.equal('0x0000000000000000000000000000000000000000', noManager, 'manager should have been removed')
                    })

                    it('old manager lost power', async () => {
                        return assertRevert(async () => {
                            await acl.grantPermission(newManager, kernelAddr, APP_MANAGER_ROLE, { from: granted })
                        })
                    })

                    it('can recreate permission', async () => {
                        const createReceipt = await acl.createPermission(newManager, kernelAddr, APP_MANAGER_ROLE, newManager, { from: permissionsRoot })
                        assertEvent(createReceipt, 'SetPermission')
                        assertEvent(createReceipt, 'ChangePermissionManager')

                        const grantReceipt = await acl.grantPermission(granted, kernelAddr, APP_MANAGER_ROLE, { from: newManager })
                        assertEvent(grantReceipt, 'SetPermission')
                    })
                })

                context('> self-revokes permission', () => {
                    beforeEach(async () => {
                        const receipt = await acl.revokePermission(granted, kernelAddr, APP_MANAGER_ROLE, { from: granted })
                        assertEvent(receipt, 'SetPermission')
                    })

                    it('can no longer perform action', async () => {
                        assert.isFalse(await acl.hasPermission(granted, kernelAddr, APP_MANAGER_ROLE))
                        await assertRevert(async () => {
                            await kernel.setApp(APP_BASES_NAMESPACE, APP_ID, appBase.address, { from: granted })
                        })
                    })

                    it('permissions root cannot re-create', async () => {
                        return assertRevert(async () => {
                            await acl.createPermission(granted, kernelAddr, APP_MANAGER_ROLE, granted, { from: permissionsRoot })
                        })
                    })

                    it('permission manager can grant the permission', async () => {
                        await acl.grantPermission(granted, kernelAddr, APP_MANAGER_ROLE, { from: granted })
                        assert.isTrue(await acl.hasPermission(granted, kernelAddr, APP_MANAGER_ROLE))
                    })
                })

                context('> re-grants to child', () => {
                    beforeEach(async () => {
                        const receipt = await acl.grantPermission(child, kernelAddr, APP_MANAGER_ROLE, { from: granted })
                        assertEvent(receipt, 'SetPermission')
                    })

                    it('child entity can perform action', async () => {
                        assert.isTrue(await acl.hasPermission(child, kernelAddr, APP_MANAGER_ROLE))
                        const receipt = await kernel.setApp(APP_BASES_NAMESPACE, APP_ID, appBase.address, { from: child })
                        assertEvent(receipt, 'SetApp')
                    })

                    it('child cannot re-grant permission', async () => {
                        const grandchild = accounts[3]
                        // Make sure grandchild doesn't have permission yet
                        assert.isFalse(await acl.hasPermission(grandchild, kernelAddr, APP_MANAGER_ROLE))
                        return assertRevert(async () => {
                            await acl.grantPermission(grandchild, kernelAddr, APP_MANAGER_ROLE, { from: child })
                        })
                    })

                    it('parent can revoke permission', async () => {
                        const receipt = await acl.revokePermission(child, kernelAddr, APP_MANAGER_ROLE, { from: granted })
                        assertEvent(receipt, 'SetPermission')
                        assert.isFalse(await acl.hasPermission(child, kernelAddr, APP_MANAGER_ROLE))
                    })
                })
            })
        })
    }
})
