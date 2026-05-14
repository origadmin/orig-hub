describe('Jest framework smoke test', () => {
  it('should run basic assertions', () => {
    expect(1 + 1).toBe(2)
    expect('hello').toBeTruthy()
    expect([1, 2, 3]).toHaveLength(3)
  })

  it('should support async tests', async () => {
    const result = await Promise.resolve('ok')
    expect(result).toBe('ok')
  })

  it('should support mock functions', () => {
    const fn = jest.fn().mockReturnValue(42)
    expect(fn()).toBe(42)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
