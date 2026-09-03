import unittest
import numpy as np
from worker import pool


class PoolTests(unittest.TestCase):
    def test_padding_mask_and_l2_normalization(self):
        result = pool(np.array([[[3., 0.], [0., 4.], [900., 900.]]]), np.array([[1, 1, 0]]))
        np.testing.assert_allclose(result, [[.6, .8]])

    def test_zero_and_nonfinite_outputs_fail(self):
        for hidden in [np.zeros((1, 2, 3)), np.full((1, 2, 3), np.nan)]:
            with self.assertRaises(ValueError):
                pool(hidden, np.ones((1, 2)))


if __name__ == '__main__':
    unittest.main()
